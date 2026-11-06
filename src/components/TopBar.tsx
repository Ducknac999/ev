
import { exitTalkMode, stopSpeaking } from "../services/voiceControl";
import { openBrowserPanel } from "../services/browserPanel";
import { activeChats, archivedChats, useChats } from "../store/chats";
import { useVoice } from "../store/voice";
import type { Chat, LayoutMode } from "../types";
import { Icon, type IconName } from "./Icon";
import { SessionGlyph, sessionLabel } from "./SessionStatus";
import { useSessionPanel } from "../store/sessionPanel";
import { useLayoutPrefs } from "../store/layoutPrefs";
import { useSettings } from "../store/settings";
import { usePopover } from "../lib/usePopover";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const LAYOUTS: { id: LayoutMode; icon: IconName; label: string; short: string }[] = [
  { id: "hud", icon: "hud", label: "Compact HUD grid", short: "Grid" },
  { id: "focus", icon: "focus", label: "Focus / split screen (up to 4)", short: "Focus" },
  { id: "tray", icon: "rows", label: "List of every session", short: "List" },
];

function TaskBadge({ chat }: { chat: Chat }) {
  const restore = () => useChats.getState().setCollapsed(chat.id, false);
  const state = chat.status === "streaming" ? "running" : chat.status === "error" ? "error" : chat.unseen ? "done" : "idle";
  const stateLabel = { running: "Running", error: "Failed", done: "Finished", idle: "Idle" }[state];
  return (
    <button
      className={`task-badge state-${state}`}
      onClick={restore}
      title={`${chat.title} — ${sessionLabel(chat)} · ${stateLabel}. Click to expand.`}
    >
      {state === "running" ? (
        <span className="spinner small" />
      ) : state === "done" ? (
        <Icon name="check" size={12} />
      ) : state === "error" ? (
        <Icon name="alert" size={12} />
      ) : (
        <SessionGlyph chat={chat} />
      )}
      <span className="task-badge-title">{chat.title}</span>
      {chat.paused && <Icon name="pause" size={11} className="muted" />}
    </button>
  );
}

/**
 * "Show when the cursor reaches the top": the bar slides in when the cursor nears the top of E.V
 * and stays while the cursor is on it. In full screen the Mac shows its own menu bar at the very
 * top, so E.V's bar sits just below it (and opens a little lower) — the two never cover each other.
 * ⌥⌘B shows or hides it from the keyboard.
 */
function useTopBarReveal(enabled: boolean): { revealed: boolean; fullscreen: boolean } {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const read = () => void win.isFullscreen().then(setFullscreen).catch(() => {});
    read();
    const off = win.onResized(read);
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const onMove = (e: MouseEvent) => {
      const zone = fullscreen ? 90 : 10; // in full screen the Mac's menu bar owns the top ~40px
      const barBottom = (fullscreen ? 40 : 0) + 64;
      setHovered((open) => (open ? e.clientY < barBottom + 24 : e.clientY < zone));
    };
    const onLeave = () => setHovered(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setPinned((p) => !p);
      }
    };
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, fullscreen]);
  return { revealed: enabled && (hovered || pinned), fullscreen };
}

function TasksMenu({ minimized, running }: { minimized: Chat[]; running: number }) {
  const { open, setOpen, pos, triggerRef, menuRef } = usePopover(280, 420);
  return (
    <>
      <button ref={triggerRef} className={`btn tasks-pill${running ? " running" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Minimized sessions">
        {running > 0 ? <span className="spinner small" /> : <Icon name="rows" size={13} />}
        <span>
          Tasks · {minimized.length}
          {running > 0 ? ` (${running} running)` : ""}
        </span>
        <Icon name={open ? "chevronUp" : "chevron"} size={11} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menuRef} className="pane-menu tasks-menu" style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }} onClick={() => setOpen(false)}>
            {minimized.map((chat) => (
              <TaskBadge key={chat.id} chat={chat} />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function TopBar({ onOpenSettings, onOpenClosed }: { onOpenSettings: () => void; onOpenClosed: () => void }) {
  const all = useChats((s) => s.chats);
  const chats = activeChats(all);
  const closedCount = archivedChats(all).length;
  const layout = useChats((s) => s.layout);
  const setLayout = useChats((s) => s.setLayout);
  const openPanel = useSessionPanel((s) => s.open);
  const sidebarOpen = useLayoutPrefs((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutPrefs((s) => s.toggleSidebar);
  const talkChatId = useVoice((s) => s.talkChatId);
  const listen = useVoice((s) => s.listen);
  const speaking = useVoice((s) => s.speaking);
  const muted = useVoice((s) => s.muted);
  const talkChat = all.find((c) => c.id === talkChatId);
  const topBarStyle = useSettings((s) => s.settings.topBarStyle);
  const topBarShow = useSettings((s) => s.settings.topBarShow);
  const { revealed, fullscreen } = useTopBarReveal(topBarShow === "hover");
  const minimized = chats.filter((c) => c.collapsed);
  const running = minimized.filter((c) => c.status === "streaming").length;

  return (
    <header
      className={`topbar style-${topBarStyle} show-${topBarShow}${revealed ? " revealed" : ""}${fullscreen ? " fullscreen" : ""}`}
      data-tauri-drag-region
    >
      <div className="topbar-left" data-tauri-drag-region>
      <button
        className={`icon-btn sidebar-toggle${sidebarOpen ? " on" : ""}`}
        onClick={toggleSidebar}
        title="Sessions sidebar (⌘B)"
        aria-pressed={sidebarOpen}
      >
        <Icon name="sidebar" />
      </button>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true" />
        E.V
      </div>

      {/* Minimized sessions fold into one "Tasks" pill with a list, instead of a row that runs off the edge. */}
      {minimized.length > 0 && topBarStyle !== "compact" && <TasksMenu minimized={minimized} running={running} />}
      </div>

      {talkChat && (
        <div className={`talk-pill state-${speaking ? "speaking" : listen}`}>
          <button className="talk-pill-main" onClick={() => useChats.getState().focusChat(talkChat.id)} title="Go to the chat that has the microphone">
            <Icon name="mic" size={13} />
            <span>
              Talking to: <b>{talkChat.title}</b>
            </span>
          </button>
          <button className="talk-pill-stop" onClick={exitTalkMode} title="Stop talking (⌘⇧T)" aria-label="Stop talking">
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div className="topbar-controls">
        <div className="segmented" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              className={layout === l.id ? "active" : ""}
              onClick={() => setLayout(l.id)}
              title={`${l.label} (⌘\\ to cycle)`}
              aria-pressed={layout === l.id}
            >
              <Icon name={l.icon} size={13} />
              <span className="seg-label">{l.short}</span>
            </button>
          ))}
        </div>

        <button
          className={`btn closed-btn${closedCount ? "" : " empty"}`}
          onClick={onOpenClosed}
          title="Closed sessions (⌘⇧A)"
          aria-label={`Closed sessions (${closedCount})`}
        >
          <Icon name="archive" size={13} /> <span className="btn-label">Closed</span>
          <span className="count">{closedCount}</span>
        </button>
        <button className="icon-btn" onClick={() => openBrowserPanel()} title="E.V Browser — browse here; your tabs stay private unless you share them">
          <Icon name="globe" />
        </button>
        <button className="btn neon" onClick={() => openPanel({ mode: "new" })} title="New session (⌘N) · Terminal (⌘T)">
          <Icon name="plus" size={14} /> <span className="btn-label">New</span>
        </button>
        <button
          className={`icon-btn mute-btn${muted ? " on" : ""}`}
          onClick={() => {
            if (!muted) stopSpeaking();
            useVoice.getState().setMuted(!muted);
          }}
          title={muted ? "E.V is muted: nothing is said out loud, everything shows in the notch. Click to unmute." : "Mute E.V: nothing is said out loud (answers show in the notch)"}
          aria-pressed={muted}
          aria-label={muted ? "Unmute E.V" : "Mute E.V"}
        >
          <Icon name={muted ? "speakerOff" : "speaker"} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings (⌘,)">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
