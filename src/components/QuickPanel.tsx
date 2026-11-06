import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PanelMessage, PanelRequest, PanelState, PanelStep } from "../services/quickPanel";
import { Markdown } from "./MessageView";
import { Icon } from "./Icon";

/**
 * The quick panel window (opened with its shortcut from any app): one E.V chat at a time, Gemini
 * style — ☰ lists every chat to switch to. Everything runs in E.V's main window; this only shows
 * what it sends and passes on what you do.
 */

type FilePayload = { name: string; mime: string; data: string };

const PLACE_KEY = "ev-panel-place";
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

function request(r: PanelRequest): void {
  void emitTo("main", "panel-request", r).catch(() => {});
}

function readFile(file: File): Promise<FilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name || "pasted image.png", mime: file.type || "application/octet-stream", data: String(reader.result).split(",")[1] ?? "" });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function stepMark(status: string): string {
  if (status === "done") return "✓";
  if (status === "denied" || status === "error") return "✕";
  if (status === "pending") return "?";
  return "…";
}

function Question({ step }: { step: PanelStep }) {
  const q = step.question!;
  if (step.status !== "pending") return <div className="qp-step-answer">{q.answer ? q.answer.join(", ") : "Skipped"}</div>;
  return (
    <div className="qp-question">
      <div className="qp-question-text">{q.question}</div>
      <div className="qp-question-options">
        {q.options.map((o) => (
          <button key={o.label} className="btn small" title={o.description} onClick={() => request({ kind: "answer", stepId: step.id, answer: [o.label] })}>
            {o.label}
          </button>
        ))}
        <button className="btn small ghost" onClick={() => request({ kind: "answer", stepId: step.id, answer: null })}>
          Skip
        </button>
      </div>
    </div>
  );
}

function Message({ message }: { message: PanelMessage }) {
  if (message.role === "user") {
    return (
      <div className="qp-msg user">
        {message.attachments.length > 0 && (
          <div className="qp-files">
            {message.attachments.map((a, i) =>
              a.preview ? <img key={i} src={a.preview} alt={a.name} className="qp-thumb" /> : <span key={i} className="qp-file">{a.name}</span>,
            )}
          </div>
        )}
        {message.content && <div className="qp-user-text">{message.content}</div>}
      </div>
    );
  }
  return (
    <div className={`qp-msg assistant${message.instant ? " instant" : ""}`}>
      {message.reasoning && (
        <details className="qp-thinking">
          <summary>Thinking</summary>
          <div>{message.reasoning}</div>
        </details>
      )}
      {message.steps.length > 0 && (
        <div className="qp-steps">
          {message.steps.map((s) => (
            <div key={s.id} className={`qp-step ${s.status}`}>
              <span className="qp-step-mark">{stepMark(s.status)}</span>
              <span className="qp-step-title">{s.title}</span>
              {s.question && <Question step={s} />}
            </div>
          ))}
        </div>
      )}
      {message.content ? <Markdown text={message.content} /> : message.pending && !message.steps.length ? <div className="qp-dots">…</div> : null}
      {message.error && <div className="qp-error">{message.error}</div>}
    </div>
  );
}

/** Talk mode for the panel's chat. Lit while it's on here; says where it is when it's on in another chat. */
function TalkButton({ chatId, talk }: { chatId: string; talk: PanelState["talk"] }) {
  const here = talk?.chatId === chatId;
  const elsewhere = talk && !here;
  const title = here
    ? "Talk mode is on for this chat — say “Hey E.V” from any app. Click to turn it off (⌘⇧T)"
    : elsewhere
      ? `Talk mode is on in “${talk.title}”. Click to move it to this chat (⌘⇧T turns it off)`
      : "Talk mode for this chat: say “Hey E.V” and a task or question, even with the panel closed (⌘⇧T)";
  return (
    <button className={`folder-chip talk-chip${here ? " on" : ""}`} title={title} onClick={() => request({ kind: "talk", on: !here })}>
      <Icon name="mic" size={11} /> {here ? "Talk on" : elsewhere ? `Talk in ${talk.title.length > 14 ? `${talk.title.slice(0, 13)}…` : talk.title}` : "Talk off"}
    </button>
  );
}

export function QuickPanel() {
  const [state, setState] = useState<PanelState | null>(null);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [dim, setDim] = useState(false);
  /** Pictures held back because the chat's model can't see them (pasted or picked, or dropped from Finder). */
  const [blocked, setBlocked] = useState<FilePayload[]>([]);
  const [blockedPaths, setBlockedPaths] = useState<string[]>([]);
  const seesImages = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chat = state?.chat ?? null;
  const stateRef = useRef<PanelState | null>(null);
  stateRef.current = state;
  seesImages.current = Boolean(chat?.seesImages);

  useEffect(() => {
    document.documentElement.classList.add("panel-root");
    const win = getCurrentWebviewWindow();
    try {
      const place = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as { x: number; y: number; w: number; h: number } | null;
      if (place) {
        void win.setPosition(new LogicalPosition(place.x, place.y)).catch(() => {});
        void win.setSize(new LogicalSize(place.w, place.h)).catch(() => {});
      }
    } catch {
      /* no saved place: the default top-center spot */
    }
    let saveTimer: number | null = null;
    const remember = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        try {
          const scale = await win.scaleFactor();
          const pos = (await win.outerPosition()).toLogical(scale);
          const size = (await win.innerSize()).toLogical(scale);
          localStorage.setItem(PLACE_KEY, JSON.stringify({ x: pos.x, y: pos.y, w: size.width, h: size.height }));
        } catch {
          /* storage unavailable: it opens at the default spot next time */
        }
      }, 300);
    };
    const offs = [
      listen<PanelState>("panel-state", (e) => setState(e.payload)),
      listen<string>("panel-dictation", (e) => {
        setText((t) => (t.trim() ? `${t.trimEnd()} ${e.payload}` : e.payload));
        input.current?.focus();
      }),
      listen<boolean>("panel-visible", (e) => {
        if (e.payload) window.setTimeout(() => input.current?.focus(), 30);
      }),
      win.onMoved(remember),
      win.onResized(remember),
      win.onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        const paths = e.payload.paths;
        const pictures = seesImages.current ? [] : paths.filter((p) => IMAGE_FILE.test(p));
        const others = paths.filter((p) => !pictures.includes(p));
        if (others.length) request({ kind: "paths", paths: others });
        if (pictures.length) setBlockedPaths((b) => [...b, ...pictures]);
      }),
    ];
    const onFocus = () => setDim(false);
    const onBlur = () => setDim(true);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    void Promise.all(offs).then(() => emitTo("main", "panel-ready")).catch(() => {});
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      offs.forEach((off) => void off.then((f) => f()).catch(() => {}));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (menu) setMenu(false);
        else request({ kind: "hide" });
      } else if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        request({ kind: "new" });
        setMenu(false);
      } else if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "t") {
        // Same as ⌘⇧T in E.V: Talk off if it's on anywhere, otherwise on for this chat.
        e.preventDefault();
        request({ kind: "talk", on: !stateRef.current?.talk });
      } else if (e.metaKey && e.key === ".") {
        e.preventDefault();
        request({ kind: "stop" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  // Opens at the newest message; keeps following new text unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state]);
  useEffect(() => {
    atBottom.current = true;
    setBlocked([]);
    setBlockedPaths([]);
  }, [chat?.id]);

  const chats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (state?.chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  }, [state?.chats, search]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const payloads = await Promise.all(files.map(readFile));
    const pictures = payloads.filter((f) => f.mime.startsWith("image/") || IMAGE_FILE.test(f.name));
    const others = payloads.filter((f) => !pictures.includes(f));
    if (others.length) request({ kind: "files", files: others });
    if (!pictures.length) return;
    if (chat?.seesImages) request({ kind: "files", files: pictures });
    else setBlocked((b) => [...b, ...pictures]);
  };

  const send = () => {
    const value = text.trim();
    if (!value && !(state?.drafts.length ?? 0)) return;
    request({ kind: "send", text: value });
    setText("");
    atBottom.current = true;
  };

  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    void getCurrentWebviewWindow().startResizeDragging("SouthEast").catch(() => {});
  };

  return (
    <div className={`quick-panel${dim ? " dim" : ""}`}>
      <header className="qp-head" data-tauri-drag-region>
        <button className={`icon-btn${menu ? " active" : ""}`} title="Your chats (switch or start a new one)" onClick={() => setMenu((m) => !m)}>
          <Icon name="rows" size={14} />
        </button>
        <span className="qp-title" data-tauri-drag-region title={chat?.title}>
          {chat?.title ?? "New chat"}
        </span>
        {chat && state && (
          <select
            className="qp-model"
            value={chat.model.model}
            title="Model for this chat"
            onChange={(e) => request({ kind: "model", model: { provider: "deepseek", model: e.target.value } })}
          >
            {!state.models.some((m) => m.model.model === chat.model.model) && <option value={chat.model.model}>{chat.modelLabel}</option>}
            {state.models.map((m) => (
              <option key={m.model.model} value={m.model.model}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        {chat && state && <TalkButton chatId={chat.id} talk={state.talk} />}
        {chat?.canThink && (
          <button className={`folder-chip think-chip${chat.thinking ? " on" : ""}`} title="Think before answering (slower, better on hard problems)" onClick={() => request({ kind: "think", on: !chat.thinking })}>
            <Icon name="spark" size={11} /> Think {chat.thinking ? "on" : "off"}
          </button>
        )}
        <button className="icon-btn" title="Hide (Esc)" onClick={() => request({ kind: "hide" })}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {menu && (
        <div className="qp-menu">
          <button
            className="qp-new"
            onClick={() => {
              request({ kind: "new" });
              setMenu(false);
            }}
          >
            <Icon name="plus" size={13} /> New chat <span className="qp-hint">⌘N</span>
          </button>
          <input className="qp-search" placeholder="Search chats" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} />
          <div className="qp-chat-list">
            {chats.map((c) => (
              <button
                key={c.id}
                className={`qp-chat${c.id === chat?.id ? " current" : ""}`}
                onClick={() => {
                  request({ kind: "switch", chatId: c.id });
                  setMenu(false);
                  setSearch("");
                }}
              >
                <span className="qp-chat-title">{c.title}</span>
                {c.archived && <span className="qp-hint">closed</span>}
              </button>
            ))}
            {!chats.length && <div className="qp-empty">No chats match.</div>}
          </div>
        </div>
      )}

      <div className="qp-messages" ref={scroller} onScroll={onScroll}>
        {!chat || chat.messages.length === 0 ? (
          <div className="qp-empty">Ask anything, or give E.V a task on your Mac.</div>
        ) : (
          chat.messages.map((m) => <Message key={m.id} message={m} />)
        )}
      </div>

      {blocked.length + blockedPaths.length > 0 && (
        <div className="qp-blocked">
          <span>
            {chat?.modelLabel ?? "This model"} can't see pictures ({[...blocked.map((b) => b.name), ...blockedPaths.map((p) => p.split("/").pop())].join(", ")}). Switch to Flash · Vision to add pictures.
          </span>
          <button
            className="btn small"
            onClick={() => {
              request({ kind: "visionAndSend", text: text.trim(), files: blocked, paths: blockedPaths });
              setBlocked([]);
              setBlockedPaths([]);
              setText("");
            }}
          >
            Switch and send
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              setBlocked([]);
              setBlockedPaths([]);
            }}
          >
            Remove
          </button>
        </div>
      )}

      {state && state.drafts.length > 0 && (
        <div className="qp-drafts">
          {state.drafts.map((d) => (
            <span key={d.id} className={`qp-file ${d.status}`} title={d.error}>
              {d.status === "uploading" ? "… " : d.status === "error" ? "✕ " : ""}
              {d.name}
              <button className="qp-x" title="Remove" onClick={() => request({ kind: "removeDraft", id: d.id })}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="qp-composer">
        <button className="icon-btn" title={chat && !chat.seesImages ? "Attach files (pictures need Flash · Vision)" : "Attach files"} onClick={() => fileInput.current?.click()}>
          <Icon name="clip" size={14} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <textarea
          ref={input}
          className="qp-input"
          rows={1}
          autoFocus
          placeholder="Type a task or question…  (hold your talk key to dictate)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {chat?.running ? (
          <button className="icon-btn stop" title="Stop (⌘.)" onClick={() => request({ kind: "stop" })}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button className="icon-btn send" title="Send (Enter)" disabled={!text.trim() && !(state?.drafts.length ?? 0)} onClick={send}>
            <Icon name="send" size={14} />
          </button>
        )}
      </div>
      <div className="qp-grip" onMouseDown={startResize} title="Resize" />
    </div>
  );
}
