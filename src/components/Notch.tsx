import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  caffeineSet,
  caffeineStatus,
  filesExist,
  lyricsFor,
  macClipboard,
  macMedia,
  notchAnswer,
  notchDragOut,
  notchFullscreen,
  notchGeometry,
  notchKeyboard,
  notchResize,
  nowPlayingInfo,
  type Caffeine,
  type FileHit,
  type NotchGeometry,
  type SongInfo,
} from "../lib/ipc";
import { shortcutLabel } from "../lib/shortcuts";
import type { NotchRequest, NotchState } from "../services/notchBridge";
import { Icon, type IconName } from "./Icon";
import { NotchClipboard, type ClipboardHandle } from "./NotchClipboard";

/**
 * The E.V notch window (src-tauri/src/notch_window.rs). Black, over the Mac's notch, and only as
 * big as what it shows: idle it hides in the notch; "wings" show music, Talk mode or ☕ beside
 * it; a bubble below it says what E.V heard or answered, asks for an approval or lists files;
 * hover (or click) opens it: Chat, Music, Drop box. Everything else lives in E.V's main window.
 */

type Tab = "chat" | "music" | "shelf" | "clipboard" | "dictation";
type Dictated = { text: string; at: number };

type Voice =
  | { kind: "listening"; text: string }
  | { kind: "heard"; text: string; at: number }
  | { kind: "say"; text: string; until: number }
  | { kind: "waiting"; until: number };

type Approval = { id: string; title: string; subtitle: string; detail: string; always: string | null };
type Files = { key: string; results: FileHit[] };
type ShelfItem = { path: string; name: string; addedAt: number; missing?: boolean };

const SHELF_KEY = "ev.shelf";

const TABS: { id: Tab; icon: IconName; label: string }[] = [
  { id: "chat", icon: "chat", label: "Chat" },
  { id: "music", icon: "music", label: "Music" },
  { id: "shelf", icon: "tray", label: "Drop box" },
  { id: "clipboard", icon: "clipboard", label: "Clipboard" },
  { id: "dictation", icon: "wave", label: "Dictation" },
];
/** Open, the notch is wide enough for the icons beside the camera. */
const OPEN_W = 520;
const SIDE_W = 168;
const WING = 46;

function request(r: NotchRequest): void {
  void emitTo("main", "notch-request", r).catch(() => {});
}

function loadShelf(): ShelfItem[] {
  try {
    return JSON.parse(localStorage.getItem(SHELF_KEY) ?? "[]") as ShelfItem[];
  } catch {
    return [];
  }
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** "[01:02.50] words" → seconds + words, in order. */
export function parseLrc(lrc: string): { t: number; text: string }[] {
  const lines: { t: number; text: string }[] = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) lines.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** Where the song is now, from Now Playing's last report. */
function position(song: SongInfo | null, now: number): number {
  if (!song?.elapsed && song?.elapsed !== 0) return 0;
  const since = song.timestamp ?? song.fetchedAt;
  const moving = song.playing ? (song.rate ?? 1) : 0;
  return Math.max(0, Math.min(song.duration ?? Infinity, song.elapsed + (now / 1000 - since) * moving));
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Re-renders every `ms` while `on` (song position, countdowns). */
function useTick(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [on, ms]);
  return now;
}

export function Notch() {
  const [geo, setGeo] = useState<NotchGeometry>({ hasNotch: true, width: 190, height: 32 });
  const [state, setState] = useState<NotchState | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [files, setFiles] = useState<Files | null>(null);
  const [hover, setHover] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [typing, setTyping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [song, setSong] = useState<SongInfo | null>(null);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [lyrics, setLyrics] = useState<{ t: number; text: string }[]>([]);
  const [plainLyrics, setPlainLyrics] = useState("");
  const [caffeine, setCaffeine] = useState<Caffeine | null>(null);
  const [caffeineNote, setCaffeineNote] = useState("");
  const [shelf, setShelf] = useState<ShelfItem[]>(loadShelf);
  const [draft, setDraft] = useState("");
  const [dictations, setDictations] = useState<Dictated[]>([]);
  /** A dictation that may not have landed (no text field): offered to copy for a few seconds. */
  const [missed, setMissed] = useState<{ text: string; until: number } | null>(null);
  const [copied, setCopied] = useState("");
  const copy = (text: string) => {
    void macClipboard(text)
      .then(() => {
        setCopied(text);
        window.setTimeout(() => setCopied(""), 1500);
      })
      .catch(() => {});
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clipRef = useRef<ClipboardHandle>(null);

  useEffect(() => {
    document.documentElement.classList.add("notch-root");
    void notchGeometry().then(setGeo).catch(() => {});
    void notchFullscreen().then(setFullscreen).catch(() => {});
    void caffeineStatus().then(setCaffeine).catch(() => {});
    const offs: Promise<() => void>[] = [
      listen<NotchState>("notch-state", (e) => setState(e.payload)),
      listen<{ event: string; text: string; seconds?: number | null }>("notch-ev", ({ payload }) => {
        const { event, text } = payload;
        if (event === "listening") setVoice({ kind: "listening", text });
        else if (event === "heard") setVoice({ kind: "heard", text, at: Date.now() });
        else if (event === "say") setVoice({ kind: "say", text, until: Date.now() + Math.max(2, payload.seconds ?? 4) * 1000 });
        else if (event === "waiting") setVoice({ kind: "waiting", until: Date.now() + Math.max(1, payload.seconds ?? 8) * 1000 });
        else if (event === "clear") setVoice(null);
      }),
      listen<{ id: string; request: Record<string, unknown> }>("notch-approval", ({ payload }) => {
        const r = payload.request;
        const s = (v: unknown) => (typeof v === "string" ? v : "");
        setApprovals((list) => [
          ...list.filter((a) => a.id !== payload.id),
          { id: payload.id, title: s(r.title) || "E.V needs your OK", subtitle: s(r.subtitle), detail: s(r.detail), always: s(r.alwaysLabel) || null },
        ]);
      }),
      listen<string>("notch-withdraw", ({ payload }) => setApprovals((list) => list.filter((a) => a.id !== payload))),
      listen<Files | null>("notch-files", ({ payload }) => setFiles(payload && payload.results.length ? payload : null)),
      listen<boolean>("notch-hover", ({ payload }) => setHover(payload)),
      listen<boolean>("notch-fullscreen", ({ payload }) => setFullscreen(payload)),
      listen("notch-open-chat", () => {
        setTab("chat");
        setPinned(true);
        window.setTimeout(() => inputRef.current?.focus(), 60);
      }),
      listen<Caffeine>("caffeine-changed", ({ payload }) => setCaffeine(payload)),
      listen<Dictated[]>("notch-dictations", ({ payload }) => setDictations(payload)),
      listen<{ text: string; missed: boolean }>("notch-dictated", ({ payload }) => {
        if (payload.missed) setMissed({ text: payload.text, until: Date.now() + 8000 });
      }),
    ];
    const drop = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setDragging(true);
        setTab("shelf");
      } else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        setTab("shelf");
        setPinned(true);
        setShelf((items) => {
          const known = new Set(items.map((i) => i.path));
          const added = p.paths.filter((path) => !known.has(path)).map((path) => ({ path, name: baseName(path), addedAt: Date.now() }));
          return [...items, ...added];
        });
      }
    });
    void emitTo("main", "notch-ready", null).catch(() => {});
    return () => {
      for (const off of offs) void off.then((f) => f()).catch(() => {});
      void drop.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SHELF_KEY, JSON.stringify(shelf.map(({ path, name, addedAt }) => ({ path, name, addedAt }))));
  }, [shelf]);

  // Hover opens it; leaving closes it a moment later (not while typing, dragging or pinned by a click).
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hover || pinned || typing || dragging) {
      const id = window.setTimeout(() => setOpen(true), hover && !pinned && !dragging ? 110 : 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setOpen(false), 450);
    return () => window.clearTimeout(id);
  }, [hover, pinned, typing, dragging]);

  useEffect(() => {
    if (open || !typing) return;
    setTyping(false);
  }, [open, typing]);

  const close = useCallback(() => {
    setPinned(false);
    setTyping(false);
    inputRef.current?.blur();
    void notchKeyboard(false).catch(() => {});
  }, []);

  // The clipboard shortcut (⌘⇧C): opens the Clipboard tab ready to search, or closes it.
  const clipOpen = open && tab === "clipboard" && (pinned || typing);
  useEffect(() => {
    const off = listen("notch-open-clipboard", () => {
      if (clipOpen) return close();
      setTab("clipboard");
      setPinned(true);
      window.setTimeout(() => clipRef.current?.focus(), 60);
    });
    return () => void off.then((f) => f()).catch(() => {});
  }, [clipOpen, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onBlur = () => {
      if (pinned && !hover) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [close, pinned, hover]);

  // Voice moments end by themselves.
  const tick = useTick(Boolean(missed || (voice && (voice.kind === "say" || voice.kind === "waiting" || voice.kind === "heard"))), 500);
  useEffect(() => {
    if (missed && tick > missed.until) setMissed(null);
  }, [tick, missed]);
  useEffect(() => {
    if (!voice) return;
    if ((voice.kind === "say" || voice.kind === "waiting") && tick > voice.until) setVoice(null);
    if (voice.kind === "heard" && tick - voice.at > 45_000) setVoice(null);
  }, [tick, voice]);

  // ── Music ────────────────────────────────────────────────────────────────
  const songKey = song?.title ? `${song.artist ?? ""}\u0000${song.title}` : "";
  const musicVisible = open && tab === "music";
  useEffect(() => {
    let stop = false;
    let last = "";
    const poll = async () => {
      const info = await nowPlayingInfo(false).catch(() => null);
      if (stop) return;
      setSong(info && info.title ? info : null);
      const key = info?.title ? `${info.artist ?? ""}\u0000${info.title}` : "";
      if (key && key !== last) {
        last = key;
        const withArt = await nowPlayingInfo(true).catch(() => null);
        if (!stop) setArtwork(withArt?.artwork ? `data:${withArt.artworkMime ?? "image/jpeg"};base64,${withArt.artwork}` : null);
      } else if (!key) {
        last = "";
        setArtwork(null);
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), musicVisible ? 1500 : 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [musicVisible]);

  useEffect(() => {
    setLyrics([]);
    setPlainLyrics("");
    if (!song?.title) return;
    let stop = false;
    void lyricsFor(song.artist ?? "", song.title, song.album, song.duration, state?.lyrics !== "never")
      .then((found) => {
        if (stop || !found) return;
        setLyrics(found.synced ? parseLrc(found.synced) : []);
        setPlainLyrics(found.synced ? "" : found.plain);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
    // Once per song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey]);

  const songTick = useTick(Boolean(song?.playing && (musicVisible || lyrics.length)), 250);
  const at = position(song, songTick);
  const line = useMemo(() => {
    let i = -1;
    for (let k = 0; k < lyrics.length; k++) if (lyrics[k].t <= at + 0.25) i = k;
    return i;
  }, [lyrics, at]);

  const media = (key: "previous" | "playpause" | "next") => {
    void macMedia(key).catch(() => {});
    window.setTimeout(() => void nowPlayingInfo(false).then((info) => setSong(info && info.title ? info : null)).catch(() => {}), 450);
  };

  // ── ☕ ────────────────────────────────────────────────────────────────────
  const toggleCaffeine = async () => {
    setCaffeineNote("");
    const prefs = state?.caffeine ?? { lid: false, batteryLimit: 0, minutes: 0 };
    try {
      setCaffeine(await caffeineSet(!caffeine?.on, prefs.lid, prefs.minutes, prefs.batteryLimit));
    } catch (err) {
      setCaffeineNote(String(err));
    }
  };

  // ── Drop box ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!(open && tab === "shelf") || !shelf.length) return;
    void filesExist(shelf.map((i) => i.path))
      .then((exists) => setShelf((items) => items.map((item, i) => ({ ...item, missing: exists[i] === false ? true : undefined }))))
      .catch(() => {});
    // Checked when the drop box opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  const dragStart = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  const onItemDown = (e: React.MouseEvent, paths: string[]) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY, paths };
  };
  const onItemMove = (e: React.MouseEvent) => {
    const start = dragStart.current;
    if (!start || !(e.buttons & 1)) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
    dragStart.current = null;
    void notchDragOut(start.paths.filter((p) => !shelf.find((i) => i.path === p)?.missing)).catch(() => {});
  };

  // ── Chat ──────────────────────────────────────────────────────────────────
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    request({ kind: "send", text });
    setDraft("");
  };

  // ── Which sections show (Settings → Notch) ────────────────────────────────
  const features = state?.features ?? { chat: true, music: true, shelf: true, dictation: true, caffeine: true };
  const visibleTabs = TABS.filter((t) => (t.id === "clipboard" ? state?.clipboard?.on !== false : features[t.id as keyof typeof features] !== false));
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((t) => t.id === tab)) setTab(visibleTabs[0].id);
  }, [visibleTabs, tab]);

  // ── Size ──────────────────────────────────────────────────────────────────
  const approval = approvals[0] ?? null;
  const banner = approval ? "approval" : files ? "files" : missed ? "missed" : voice ? "voice" : null;
  const wings = Boolean((features.music && song?.playing) || state?.talk.on || caffeine?.on || voice?.kind === "listening");
  const mode: "idle" | "wings" | "bubble" | "open" = open ? "open" : banner ? "bubble" : wings ? "wings" : "idle";
  // A full-screen app owns the top of the screen: the notch shows only for something to answer
  // (an approval, what E.V said) or when you open it with a shortcut.
  // Hidden, pushing the pointer against the top edge over the notch slides it out (notch_window.rs).
  const hidden = fullscreen && state?.hideInFullscreen !== false && (mode === "idle" || mode === "wings");

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      setContentHeight(0);
      return;
    }
    const measure = () => setContentHeight(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode, tab]);

  const target = useMemo(() => {
    const h = geo.height;
    if (hidden) return { w: 0, h: 0 };
    if (mode === "idle") return { w: geo.width, h };
    if (mode === "wings") return { w: geo.width + WING * 2, h };
    const w = mode === "open" ? Math.min(600, Math.max(OPEN_W, geo.width + SIDE_W * 2)) : 400;
    return { w, h: Math.min(mode === "open" ? 420 : 300, h + contentHeight + 4) };
  }, [geo, mode, contentHeight, hidden]);

  // The window never moves (src-tauri/src/notch_window.rs): only the shape animates inside it.
  const shape = target;
  useEffect(() => {
    void notchResize(target.w, target.h).catch(() => {});
  }, [target]);

  const radius = mode === "idle" || mode === "wings" ? Math.min(14, geo.height / 2.4) : 20;

  return (
    <div className="notch-stage">
      <div
        className={`notch-shape mode-${mode} ${geo.hasNotch ? "has-notch" : "pill"} ${hidden ? "hidden" : ""}`}
        style={{ width: shape.w, height: shape.h, borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}
        onMouseDown={() => {
          if (mode !== "open") setPinned(true);
        }}
      >
        <div className="notch-top" style={{ height: geo.height }}>
          {/* Open, the music card shows the song: the small cover beside the notch would be a second one. */}
          {(mode === "wings" || mode === "bubble") && (
            <>
              <div className="notch-wing left">
                {voice?.kind === "listening" ? (
                  <Bars live className="mic" />
                ) : features.music && artwork && song?.playing ? (
                  <img className="notch-art-mini" src={artwork} alt="" />
                ) : state?.talk.on ? (
                  <Icon name="mic" size={14} className="talk-on" />
                ) : null}
              </div>
              <div className="notch-gap" style={{ width: geo.width }} />
              <div className="notch-wing right">
                {caffeine?.on && <Icon name="cup" size={14} className={`notch-cup ${caffeine.lid ? "lid" : ""}`} />}
                {features.music && song?.playing && <Bars live={song.playing} />}
              </div>
            </>
          )}
          {/* Open: the sections left of the camera, the switches right of it. */}
          {mode === "open" && (
            <>
              <div className="notch-side left" style={{ width: (shape.w - geo.width) / 2 }}>
                {visibleTabs.map((t) => (
                  <button
                    key={t.id}
                    className={`notch-tab ${tab === t.id ? "on" : ""}`}
                    title={t.id === "clipboard" && state?.clipboard?.shortcut ? `${t.label} · ${shortcutLabel(state.clipboard.shortcut)}` : t.label}
                    aria-label={t.label}
                    onClick={() => setTab(t.id)}
                  >
                    <Icon name={t.icon} size={15} />
                    {t.id === "shelf" && shelf.length > 0 && <span className="notch-badge">{shelf.length}</span>}
                  </button>
                ))}
              </div>
              <div className="notch-gap" style={{ width: geo.width }} />
              <div className="notch-side right" style={{ width: (shape.w - geo.width) / 2 }}>
                <button
                  className={`notch-tab ${state?.talk.on ? "on" : ""}`}
                  title={state?.talk.on ? "Talk mode is on — click to turn it off" : "Talk mode"}
                  onClick={() => request({ kind: "talk", on: !state?.talk.on })}
                >
                  <Icon name="mic" size={15} />
                </button>
                {(features.caffeine || caffeine?.on) && (
                <button
                  className={`notch-tab ${caffeine?.on ? "on" : ""}`}
                  title={caffeine?.on ? `Caffeine is on${caffeine.lid ? " (lid closed too)" : ""} — click to let the Mac sleep` : "Caffeine: keep the Mac awake"}
                  onClick={() => void toggleCaffeine()}
                >
                  <Icon name="cup" size={15} />
                </button>
                )}
                <button
                  className={`notch-tab ${state?.chatPanels ? "on" : ""}`}
                  title={state?.chatPanels ? "Chat panels on — click to hide E.V's window and use the notch" : "Chat panels off — click to show E.V's window again"}
                  onClick={() => request({ kind: "chatPanels", on: !state?.chatPanels })}
                >
                  <Icon name="split" size={15} />
                </button>
                <button className="notch-tab" title="Open E.V" onClick={() => request({ kind: "openMain" })}>
                  <Icon name="expand" size={15} />
                </button>
              </div>
            </>
          )}
        </div>

        {mode === "bubble" && (
          <div className="notch-content" ref={contentRef}>
            {banner === "approval" && approval && <ApprovalCard approval={approval} onDone={(id) => setApprovals((l) => l.filter((a) => a.id !== id))} />}
            {banner === "files" && files && <FilesCard files={files} onDone={() => setFiles(null)} />}
            {banner === "missed" && missed && (
              <MissedCard
                text={missed.text}
                copied={copied === missed.text}
                onCopy={() => {
                  copy(missed.text);
                  window.setTimeout(() => setMissed(null), 900);
                }}
              />
            )}
            {banner === "voice" && voice && <VoiceLine voice={voice} now={tick} />}
          </div>
        )}

        {mode === "open" && (
          <div className="notch-content" ref={contentRef}>
            {approval && <ApprovalCard approval={approval} onDone={(id) => setApprovals((l) => l.filter((a) => a.id !== id))} />}
            {!approval && files && <FilesCard files={files} onDone={() => setFiles(null)} />}
            {!approval && !files && voice && voice.kind !== "listening" && <VoiceLine voice={voice} now={tick} />}

            {caffeineNote && <div className="notch-note">{caffeineNote}</div>}

            {tab === "chat" && (
              <div className="notch-chat">
                <div className="notch-messages">
                  {(state?.chat?.messages ?? []).slice(-4).map((m) => (
                    <div key={m.id} className={`notch-msg ${m.role}`}>
                      {m.content || (m.pending ? "…" : "")}
                    </div>
                  ))}
                  {!state?.chat?.messages.length && <div className="notch-empty">{state?.chat ? `Ask ${state.chat.title} anything.` : "Ask E.V anything."}</div>}
                </div>
                <div className="notch-input">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={draft}
                    placeholder={state?.talk.on ? "Type, or say “Hey E.V”…" : "Message E.V…"}
                    onFocus={() => {
                      setTyping(true);
                      void notchKeyboard(true).catch(() => {});
                    }}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  {state?.chat?.running ? (
                    <button className="notch-icon" title="Stop" onClick={() => request({ kind: "stop" })}>
                      <Icon name="stop" size={14} />
                    </button>
                  ) : (
                    <button className="notch-icon send" title="Send" disabled={!draft.trim()} onClick={send}>
                      <Icon name="send" size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {tab === "music" && (
              <div className="notch-music">
                {song ? (
                  <>
                    <div className="notch-song">
                      {artwork ? <img className="notch-art" src={artwork} alt="" /> : <div className="notch-art blank" />}
                      <div className="notch-song-text">
                        <div className="notch-title">{song.title}</div>
                        <div className="notch-artist">{[song.artist, song.app].filter(Boolean).join(" · ")}</div>
                        {song.duration ? (
                          <div className="notch-progress">
                            <span>{clock(at)}</span>
                            <div className="track">
                              <div className="fill" style={{ width: `${Math.min(100, (at / song.duration) * 100)}%` }} />
                            </div>
                            <span>{clock(song.duration)}</span>
                          </div>
                        ) : null}
                      </div>
                      <div className="notch-controls">
                        <button className="notch-icon" title="Previous" onClick={() => media("previous")}>
                          <Icon name="back" size={14} />
                        </button>
                        <button className="notch-icon big" title={song.playing ? "Pause" : "Play"} onClick={() => media("playpause")}>
                          <Icon name={song.playing ? "pause" : "play"} size={16} />
                        </button>
                        <button className="notch-icon" title="Next" onClick={() => media("next")}>
                          <Icon name="forward" size={14} />
                        </button>
                      </div>
                    </div>
                    {lyrics.length > 0 ? (
                      <div className="notch-lyrics">
                        <div className="dim">{lyrics[line - 1]?.text ?? ""}</div>
                        <div className="now">{lyrics[line]?.text || (line < 0 ? "♪" : "")}</div>
                        <div className="dim">{lyrics[line + 1]?.text ?? ""}</div>
                      </div>
                    ) : plainLyrics ? (
                      <div className="notch-lyrics plain">{plainLyrics.split("\n").slice(0, 3).join("\n")}</div>
                    ) : null}
                  </>
                ) : (
                  <div className="notch-empty">Nothing is playing.</div>
                )}
              </div>
            )}

            {tab === "clipboard" && (
              <NotchClipboard
                ref={clipRef}
                shortcut={state?.clipboard?.shortcut ?? ""}
                onTyping={(on) => {
                  setTyping(on);
                  if (on) void notchKeyboard(true).catch(() => {});
                }}
                onDone={() => {
                  setPinned(false);
                  setTyping(false);
                }}
              />
            )}

            {tab === "dictation" && (
              <div className="notch-dictations">
                {dictations.length === 0 ? (
                  <div className="notch-empty">Hold your dictation key and talk — what you say shows up here too.</div>
                ) : (
                  <>
                    <button className="notch-file all" onClick={() => copy(dictations[0].text)}>
                      {copied === dictations[0].text ? "Copied ✓" : "Copy last dictation"}
                    </button>
                    <div className="notch-files">
                      {dictations.map((d) => (
                        <button key={d.at} className="notch-dictation" title="Click to copy" onClick={() => copy(d.text)}>
                          <span className="when">{new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                          <span className="name">{copied === d.text ? "Copied ✓" : d.text}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === "shelf" && (
              <div className={`notch-shelf ${dragging ? "dropping" : ""}`} onMouseMove={onItemMove} onMouseUp={() => (dragStart.current = null)}>
                {shelf.length === 0 ? (
                  <div className="notch-drop">Drop files here to keep them handy, then drag them out wherever you want them.</div>
                ) : (
                  <>
                    <div className="notch-files">
                      {shelf.map((item) => (
                        <div
                          key={item.path}
                          className={`notch-file ${item.missing ? "missing" : ""}`}
                          title={item.missing ? `${item.path} — moved or deleted` : `${item.path}\nDrag it out to use it`}
                          onMouseDown={(e) => onItemDown(e, [item.path])}
                        >
                          <span className="ext">{item.name.includes(".") ? item.name.split(".").pop()!.slice(0, 4) : "—"}</span>
                          <span className="name">{item.name}</span>
                          {item.missing && <span className="gone">missing</span>}
                          <button className="x" title="Remove" onMouseDown={(e) => e.stopPropagation()} onClick={() => setShelf((l) => l.filter((i) => i.path !== item.path))}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="notch-shelf-bar">
                      <div className="notch-file all" onMouseDown={(e) => onItemDown(e, shelf.map((i) => i.path))} title="Drag all of them out at once">
                        Drag all {shelf.length}
                      </div>
                      <button className="notch-link" onClick={() => setShelf([])}>
                        Clear
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Bars({ live, className = "" }: { live: boolean; className?: string }) {
  return (
    <span className={`notch-bars ${live ? "live" : ""} ${className}`}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function VoiceLine({ voice, now }: { voice: Voice; now: number }) {
  if (voice.kind === "listening") {
    return (
      <div className="notch-voice">
        <Bars live className="mic" />
        <span className="muted">{voice.text || "Listening…"}</span>
      </div>
    );
  }
  if (voice.kind === "heard") {
    return (
      <div className="notch-voice">
        <span className="you">“{voice.text}”</span>
        <span className="muted thinking">Thinking…</span>
      </div>
    );
  }
  if (voice.kind === "waiting") {
    return (
      <div className="notch-voice">
        <Bars live className="mic" />
        <span className="muted">Listening for your answer… {Math.max(0, Math.ceil((voice.until - now) / 1000))}s</span>
      </div>
    );
  }
  return (
    <div className="notch-voice say">
      {/^(next song|previous song|paused|playing|muted|unmuted|volume|opening|dark mode|light mode)/i.test(voice.text) && <span className="tick">✓</span>}
      <span>{voice.text}</span>
    </div>
  );
}

function ApprovalCard({ approval, onDone }: { approval: Approval; onDone: (id: string) => void }) {
  const answer = (decision: "allow" | "always" | "deny") => {
    void notchAnswer(approval.id, decision).catch(() => {});
    onDone(approval.id);
  };
  return (
    <div className="notch-card approval">
      <div className="notch-card-title">{approval.title}</div>
      {approval.subtitle && <div className="notch-card-sub">{approval.subtitle}</div>}
      {approval.detail && <div className="notch-card-detail">{approval.detail}</div>}
      <div className="notch-buttons">
        <button className="primary" onClick={() => answer("allow")}>
          Approve
        </button>
        {approval.always && (
          <button title={`Always allow: ${approval.always}`} onClick={() => answer("always")}>
            Always
          </button>
        )}
        <button onClick={() => answer("deny")}>Skip</button>
      </div>
    </div>
  );
}

function FilesCard({ files, onDone }: { files: Files; onDone: () => void }) {
  return (
    <div className="notch-card">
      <div className="notch-card-title">{files.results[0]?.named === false ? "Nothing's named that — these mention it" : "Which one?"}</div>
      {files.results.slice(0, 5).map((hit, i) => (
        <button
          key={hit.path}
          className="notch-hit"
          title={hit.path}
          onClick={() => {
            request({ kind: "pickFile", key: files.key, path: hit.path });
            onDone();
          }}
        >
          <span className="n">{i + 1}</span>
          <span className="name">{hit.name}</span>
          <span className="where">
            {hit.folder}
            {hit.when ? ` · ${hit.when}` : ""}
          </span>
        </button>
      ))}
      <div className="notch-card-sub">Say “the first one” (or its number), or click it.</div>
    </div>
  );
}

function MissedCard({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="notch-card">
      <div className="notch-card-title">Nowhere to type? Here's what you said</div>
      <div className="notch-card-detail">{text}</div>
      <div className="notch-buttons">
        <button className="primary" onClick={onCopy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
