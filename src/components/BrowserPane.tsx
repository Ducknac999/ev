import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  gbCloseTab,
  gbInsertText,
  gbKey,
  gbMouse,
  gbNavigate,
  gbNewTab,
  gbSelection,
  gbShare,
  gbTabs,
  gbView,
  gbViewStop,
  macClipboard,
  type BrowserTab,
} from "../lib/ipc";
import { useBrowserView } from "../services/browserPanel";
import { useChats } from "../store/chats";
import { useNotice } from "../store/notice";
import type { Chat } from "../types";
import { ChatControls } from "./ChatControls";
import type { PaneVariant } from "./ChatPane";
import { Icon } from "./Icon";

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;
/** ⌘-shortcuts that are editing commands inside the page. */
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", z: "undo" };

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * E.V's Browser panel: the E.V Browser (its own hidden browser) shown live. You browse it
 * like any browser. Tabs you open are private — the AI can't see them — until you share one; tabs
 * the AI opened are marked as E.V's, so you can watch what it did.
 */
export function BrowserPane({ chat, index, focused, variant }: { chat: Chat; index: number; focused: boolean; variant: PaneVariant }) {
  const tab = useBrowserView((s) => s.tab);
  const setTab = useBrowserView((s) => s.setTab);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [loading, setLoading] = useState(true);
  const screenRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const moveFrame = useRef<number | null>(null);
  const triedNewTab = useRef(false);
  const current = tabs.find((t) => t.name === tab);

  const refresh = useCallback(() => gbTabs().then(setTabs, () => setTabs([])), []);

  // Tabs: keep the strip up to date; a page a tab opened by itself becomes the shown tab.
  useEffect(() => {
    void refresh();
    const off = listen<{ focus?: string | null }>("gb-tabs", (e) => {
      void refresh();
      if (e.payload?.focus) setTab(e.payload.focus);
    });
    return () => void off.then((f) => f());
  }, [refresh, setTab]);

  // Nothing chosen yet: show the user's first tab, or open a fresh one.
  useEffect(() => {
    if (chat.collapsed) return;
    if (tab && (tabs.some((t) => t.name === tab) || loading)) return;
    const mine = tabs.find((t) => t.mine) ?? tabs[0];
    if (mine) setTab(mine.name);
    else if (!triedNewTab.current) {
      // Once per panel: if the browser can't start, say so instead of retrying forever.
      triedNewTab.current = true;
      void gbNewTab().then(
        (name) => {
          if (name) setTab(name);
          void refresh();
        },
        (err) => {
          setLoading(false);
          useNotice.getState().show({ message: `E.V Browser: ${String(err)}` });
        },
      );
    }
  }, [tab, tabs, loading, chat.collapsed, setTab, refresh]);

  // Stream the shown tab at the panel's size.
  useEffect(() => {
    const el = screenRef.current;
    if (!tab || !el || chat.collapsed) return;
    let timer: number | undefined;
    const start = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width < 50 || height < 50) return;
      void gbView(tab, Math.round(width), Math.round(height), Math.min(2, window.devicePixelRatio || 1))
        .then(() => setLoading(false))
        .catch((err) => useNotice.getState().show({ message: `E.V Browser: ${String(err)}` }));
    };
    start();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(start, 150);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      void gbViewStop();
    };
  }, [tab, chat.collapsed]);

  useEffect(() => {
    const off = listen<{ data: string }>("gb-frame", (e) => {
      if (imgRef.current && e.payload?.data) imgRef.current.src = `data:image/jpeg;base64,${e.payload.data}`;
    });
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    if (!editingAddress) setAddress(current?.url && current.url !== "about:blank" ? current.url : "");
  }, [current?.url, editingAddress]);

  // ── Your mouse and keys, passed into the page ──
  const point = (e: React.MouseEvent | React.WheelEvent) => {
    const r = screenRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onMouse = (kind: "mousePressed" | "mouseReleased") => (e: React.MouseEvent) => {
    if (kind === "mousePressed") screenRef.current?.focus();
    e.preventDefault();
    void gbMouse({ kind, ...point(e), button: BUTTONS[e.button] ?? "left", clicks: e.detail || 1, modifiers: modifiers(e) }).catch(() => {});
  };
  const onMove = (e: React.MouseEvent) => {
    const at = point(e);
    const mods = modifiers(e);
    const buttons = e.buttons;
    if (moveFrame.current !== null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      void gbMouse({ kind: "mouseMoved", ...at, button: buttons & 1 ? "left" : "none", modifiers: mods }).catch(() => {});
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    void gbMouse({ kind: "mouseWheel", ...point(e), dx: e.deltaX, dy: e.deltaY, modifiers: modifiers(e) }).catch(() => {});
  };

  const onKey = (kind: "down" | "up") => async (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.metaKey && kind === "down") {
      // Browser-style shortcuts for the panel itself.
      if (k === "l") return e.preventDefault(), addressRef.current?.focus(), addressRef.current?.select();
      if (k === "r") return e.preventDefault(), void gbNavigate("reload");
      if (k === "t") return e.preventDefault(), void newTab();
      if (k === "[") return e.preventDefault(), void gbNavigate("back");
      if (k === "]") return e.preventDefault(), void gbNavigate("forward");
      // The hidden browser has no clipboard of its own: copy and paste go through the Mac's.
      if (k === "c" || k === "x") {
        e.preventDefault();
        const text = await gbSelection().catch(() => "");
        if (text) await macClipboard(text).catch(() => {});
        if (k === "x") void gbKey({ kind: "rawKeyDown", key: "Delete", code: "Delete", keyCode: 46 });
        return;
      }
      if (k === "v") {
        e.preventDefault();
        const text = await macClipboard().catch(() => "");
        if (text) void gbInsertText(text);
        return;
      }
      const command = EDIT_COMMANDS[k];
      if (command) {
        e.preventDefault();
        void gbKey({ kind: "rawKeyDown", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: 4, commands: [e.shiftKey && k === "z" ? "redo" : command] });
        return;
      }
      return; // other ⌘ shortcuts stay with E.V (⌘1–9, ⌘W…)
    }
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = kind === "down" ? (printable ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined;
    void gbKey({
      kind: kind === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      text,
      modifiers: modifiers(e),
    }).catch(() => {});
  };

  const newTab = async (url?: string) => {
    const name = await gbNewTab(url).catch((err) => (useNotice.getState().show({ message: `E.V Browser: ${String(err)}` }), null));
    if (name) setTab(name);
    void refresh();
  };

  const closeTab = async (name: string) => {
    await gbCloseTab(name).catch(() => {});
    if (name === tab) setTab(null);
    void refresh();
  };

  const toggleShare = (t: BrowserTab) => {
    void gbShare(t.name, !t.shared).then(refresh);
    useNotice.getState().show({
      message: t.shared ? `“${t.title || host(t.url)}” is private again — E.V can't see it.` : `Shared “${t.title || host(t.url)}” — ask any E.V chat about it (“look at my browser tab”).`,
    });
  };

  return (
    <section
      className={`chat-pane browser-pane variant-${variant}${focused ? " focused" : ""}${chat.collapsed ? " collapsed" : ""}`}
      onPointerDownCapture={() => !focused && useChats.getState().focusChat(chat.id)}
      aria-label={chat.title}
      data-session-id={chat.id}
    >
      <header className="pane-head">
        <div className="pane-row">
          <span className="pane-index">{String(index + 1).padStart(2, "0")}</span>
          <h2 className="pane-title">
            <Icon name="globe" size={13} /> E.V Browser
          </h2>
          <span className="browser-note">E.V's own browser and account — never yours</span>
          <ChatControls chat={chat} focusAction={variant === "card" ? "expand" : "dock"} />
        </div>
        {!chat.collapsed && (
          <>
            <div className="browser-tabs" role="tablist">
              {tabs.map((t) => (
                <div key={t.name} className={`browser-tab${t.name === tab ? " active" : ""}${t.mine ? " mine" : " ai"}`} role="tab" aria-selected={t.name === tab}>
                  <button className="browser-tab-main" onClick={() => setTab(t.name)} title={t.url}>
                    {t.mine ? null : <span className="tab-owner">E.V</span>}
                    <span className="tab-title">{t.title || host(t.url) || "New tab"}</span>
                  </button>
                  {t.mine && (
                    <button
                      className={`tab-share${t.shared ? " on" : ""}`}
                      onClick={() => toggleShare(t)}
                      title={t.shared ? "Shared with E.V — click to make it private" : "Private — E.V can't see this tab. Click to share it"}
                    >
                      <Icon name={t.shared ? "eye" : "lock"} size={11} />
                    </button>
                  )}
                  <button className="tab-close" onClick={() => void closeTab(t.name)} title="Close tab" aria-label="Close tab">
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ))}
              <button className="icon-btn ghost small" onClick={() => void newTab()} title="New private tab (⌘T)" aria-label="New tab">
                <Icon name="plus" size={12} />
              </button>
            </div>
            <div className="browser-bar">
              <button className="icon-btn ghost small" onClick={() => void gbNavigate("back")} title="Back (⌘[)" aria-label="Back">
                <Icon name="back" size={13} />
              </button>
              <button className="icon-btn ghost small" onClick={() => void gbNavigate("forward")} title="Forward (⌘])" aria-label="Forward">
                <Icon name="forward" size={13} />
              </button>
              <button className="icon-btn ghost small" onClick={() => void gbNavigate("reload")} title="Reload (⌘R)" aria-label="Reload">
                <Icon name="refresh" size={12} />
              </button>
              <input
                ref={addressRef}
                className="browser-address"
                value={address}
                placeholder="Search Google or type an address"
                spellCheck={false}
                onFocus={() => setEditingAddress(true)}
                onBlur={() => setEditingAddress(false)}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && address.trim()) {
                    void gbNavigate("go", address.trim());
                    screenRef.current?.focus();
                  }
                  if (e.key === "Escape") screenRef.current?.focus();
                }}
              />
              {current?.mine && (
                <span className={`browser-privacy${current.shared ? " shared" : ""}`}>
                  <Icon name={current.shared ? "eye" : "lock"} size={11} /> {current.shared ? "E.V can see this tab" : "Private"}
                </span>
              )}
            </div>
          </>
        )}
      </header>
      {!chat.collapsed && (
        <div
          ref={screenRef}
          className="browser-screen"
          tabIndex={0}
          onMouseDown={onMouse("mousePressed")}
          onMouseUp={onMouse("mouseReleased")}
          onMouseMove={onMove}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKey("down")}
          onKeyUp={onKey("up")}
        >
          <img ref={imgRef} alt="" draggable={false} />
          {loading && <div className="browser-loading">Starting the E.V Browser…</div>}
        </div>
      )}
    </section>
  );
}
