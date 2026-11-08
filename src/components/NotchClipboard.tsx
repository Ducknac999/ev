import { listen } from "@tauri-apps/api/event";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { clipClear, clipDelete, clipHistory, clipIcons, clipPick, clipPin, type ClipItem } from "../lib/ipc";
import { Icon, type IconName } from "./Icon";
import { shortcutLabel } from "../lib/shortcuts";

/**
 * The notch's Clipboard tab: everything you copied (src-tauri/src/clipboard.rs), newest first,
 * pinned ones on top. Type to search; ↑↓ to move; Enter pastes into the app you were in;
 * ⌥Enter only copies; ⌘1–⌘9 paste one of the first nine; ⌘P pins; ⌘⌫ deletes.
 */

export interface ClipboardHandle {
  focus: () => void;
}

function label(item: ClipItem): string {
  if (item.kind === "files") {
    const names = (item.files ?? []).map((p) => p.split("/").filter(Boolean).pop() ?? p);
    return names.length > 1 ? `${names[0]} + ${names.length - 1} more` : (names[0] ?? "Files");
  }
  if (item.kind === "image") return item.width && item.height ? `Image · ${item.width}×${item.height}` : "Image";
  return (item.text ?? "").replace(/\s+/g, " ").trim();
}

/** "22:18" today, "Nov 7" before. */
function when(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const KIND_ICON: Record<ClipItem["kind"], IconName> = { text: "rows", link: "link", image: "eye", files: "file" };

function matches(item: ClipItem, query: string): boolean {
  if (!query) return true;
  const hay = [item.text ?? "", ...(item.files ?? []), item.app ?? "", item.kind].join("\n").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export const NotchClipboard = forwardRef<ClipboardHandle, { shortcut: string; onTyping: (on: boolean) => void; onDone: () => void }>(function NotchClipboard(
  { shortcut, onTyping, onDone },
  ref,
) {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      setQuery("");
      setSelected(0);
      searchRef.current?.focus();
    },
  }));

  useEffect(() => {
    const load = () => {
      void clipHistory().then(setItems).catch(() => {});
      void clipIcons().then(setIcons).catch(() => {});
    };
    load();
    const off = listen("clipboard-changed", load);
    return () => void off.then((f) => f()).catch(() => {});
  }, []);

  const shown = useMemo(() => {
    const found = items.filter((i) => matches(i, query.trim()));
    return [...found.filter((i) => i.pinned), ...found.filter((i) => !i.pinned)];
  }, [items, query]);

  useEffect(() => {
    if (selected >= shown.length) setSelected(Math.max(0, shown.length - 1));
  }, [shown.length, selected]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pick = (item: ClipItem | undefined, paste: boolean) => {
    if (!item) return;
    setNote("");
    void clipPick(item.id, paste)
      .then(() => {
        if (paste) onDone();
        else {
          setNote("Copied ✓");
          window.setTimeout(() => setNote(""), 1200);
        }
      })
      .catch((err) => {
        const text = String(err);
        setNote(
          text.includes("PERMISSION:accessibility")
            ? "Copied — paste with ⌘V. (To paste for you, E.V needs Accessibility: System Settings → Privacy & Security.)"
            : text,
        );
      });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const item = shown[selected];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(item, !e.altKey);
    } else if (e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      pick(shown[Number(e.key) - 1], true);
    } else if (e.metaKey && e.key.toLowerCase() === "p" && item) {
      e.preventDefault();
      void clipPin(item.id, !item.pinned).catch(() => {});
    } else if (e.metaKey && e.key === "Backspace" && item) {
      e.preventDefault();
      void clipDelete(item.id).catch(() => {});
    }
  };

  const keyLabel = shortcut ? shortcutLabel(shortcut) : "";
  return (
    <div className="notch-clipboard">
      <div className="notch-input clip-search">
        <input
          ref={searchRef}
          value={query}
          placeholder={items.length ? `Search ${items.length} copied item${items.length === 1 ? "" : "s"}…` : "Search…"}
          onFocus={() => onTyping(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKey}
        />
        {items.length > 0 &&
          (confirmClear ? (
            <span className="clip-confirm">
              <button className="notch-link" onClick={() => (setConfirmClear(false), void clipClear(false).catch(() => {}))}>
                Clear all but pinned
              </button>
              <button className="notch-link" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="clip-action" title="Clear the history (pinned ones stay)" onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={14} />
            </button>
          ))}
      </div>
      {note && <div className="clip-note">{note}</div>}
      {items.length === 0 ? (
        <div className="notch-empty">Copy anything — text, links, images, files — and it shows up here.{keyLabel ? ` ${keyLabel} opens this from any app.` : ""}</div>
      ) : shown.length === 0 ? (
        <div className="notch-empty">Nothing copied matches “{query}”.</div>
      ) : (
        <div className="notch-files clip-list" ref={listRef}>
          {shown.map((item, i) => (
            <div
              key={item.id}
              data-index={i}
              className={`clip-card kind-${item.kind} ${i === selected ? "on" : ""}`}
              title={`${item.kind === "files" ? (item.files ?? []).join("\n") : (item.text ?? "").slice(0, 600)}\nEnter or click pastes · ⌥ copies only`}
              onMouseEnter={() => setSelected(i)}
              onClick={(e) => pick(item, !e.altKey)}
            >
              {item.kind === "image" && item.thumb ? (
                <img className="clip-image" src={`data:image/png;base64,${item.thumb}`} alt="" />
              ) : item.kind === "files" ? (
                <div className="clip-file">
                  {item.thumb ? <img className={item.fileIcon ? "icon" : "pic"} src={`data:image/png;base64,${item.thumb}`} alt="" /> : <Icon name="file" size={22} />}
                  <span>{label(item)}</span>
                </div>
              ) : (
                <div className={`clip-text ${item.kind === "link" ? "link" : ""}`}>{label(item)}</div>
              )}
              <div className="clip-meta">
                {item.bundle && icons[item.bundle] ? (
                  <img className="clip-app" src={`data:image/png;base64,${icons[item.bundle]}`} alt="" title={item.app ? `From ${item.app}` : undefined} />
                ) : (
                  <Icon name={KIND_ICON[item.kind]} size={12} className="clip-kind" />
                )}
                <span className="clip-when">{when(item.at)}</span>
                {item.kind === "image" && item.width ? <span className="clip-when">{`${item.width}×${item.height}`}</span> : null}
                {item.pinned && <Icon name="pin" size={12} className="clip-pinned" />}
                <span className="clip-fill" />
                <span className="clip-actions">
                  <button
                    className="clip-action"
                    title="Copy (don't paste)"
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(item, false);
                    }}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                  <button
                    className={`clip-action ${item.pinned ? "on" : ""}`}
                    title={item.pinned ? "Unpin" : "Pin — kept until you unpin it"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void clipPin(item.id, !item.pinned).catch(() => {});
                    }}
                  >
                    <Icon name="pin" size={13} />
                  </button>
                  <button
                    className="clip-action"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void clipDelete(item.id).catch(() => {});
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
                {i < 9 && <span className="clip-key">⌘{i + 1}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

