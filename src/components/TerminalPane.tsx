import { useEffect, useRef, useState } from "react";
import { pickSavePath, ptyLog, ptySignal, saveTextFile } from "../lib/ipc";
import { dictation, stopSpeaking } from "../services/voiceControl";
import {
  attachTerminal,
  clearSearch,
  focusTerminal,
  restartTerminal,
  searchTerminal,
  useTerminals,
  writeToTerminal,
} from "../services/terminals";
import { useChats } from "../store/chats";
import { useNotice } from "../store/notice";
import { useDropTarget } from "../store/dropTarget";
import { useSessionPanel } from "../store/sessionPanel";
import { useVoice } from "../store/voice";
import type { Chat } from "../types";
import { ChatControls } from "./ChatControls";
import { Icon } from "./Icon";
import { SessionStatusPill } from "./SessionStatus";
import { ClaudeUsageRow } from "./Usage";
import type { PaneVariant } from "./ChatPane";

const KIND_LABEL: Record<Exclude<Chat["kind"], "ai">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  shell: "Terminal",
  command: "Command",
  browser: "E.V Browser",
};

function shortPath(path: string | undefined): string {
  if (!path) return "~";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function TerminalPane({
  chat,
  index,
  focused,
  variant,
}: {
  chat: Chat;
  index: number;
  focused: boolean;
  variant: PaneVariant;
}) {
  const { focusChat, renameChat } = useChats.getState();
  const runtime = useTerminals((s) => s.byId[chat.id]);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(chat.title);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const dictatingChatId = useVoice((s) => s.dictatingChatId);
  const dictating = dictatingChatId === chat.id;
  const kind = chat.kind as Exclude<Chat["kind"], "ai">;
  const dropping = useDropTarget((s) => s.targetId === chat.id);

  useEffect(() => {
    if (chat.collapsed || !containerRef.current) return;
    return attachTerminal(chat.id, containerRef.current);
  }, [chat.id, chat.collapsed]);

  useEffect(() => {
    if (focused && !chat.collapsed && !searchOpen) focusTerminal(chat.id);
  }, [focused, chat.collapsed, chat.id, searchOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
    else clearSearch(chat.id);
  }, [searchOpen, chat.id]);

  const commitTitle = () => {
    setEditing(false);
    if (draftTitle.trim() && draftTitle !== chat.title) renameChat(chat.id, draftTitle);
  };

  const copyLog = async () => {
    const text = await ptyLog(chat.id).catch(() => "");
    await navigator.clipboard.writeText(text).catch(() => {});
    useNotice.getState().show({ message: `Copied ${text.split("\n").length} lines from ${chat.title}.` });
  };

  const saveLog = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const path = await pickSavePath(`${chat.title.replace(/[^\w.-]+/g, "_")}-${stamp}.log`).catch(() => null);
    if (!path) return;
    const text = await ptyLog(chat.id).catch(() => "");
    await saveTextFile(path, text);
    useNotice.getState().show({ message: `Saved log to ${shortPath(path)}.` });
  };

  const toggleDictation = async () => {
    if (dictating) {
      setTranscribing(true);
      try {
        const transcript = await dictation.stop();
        if (transcript) writeToTerminal(chat.id, transcript);
      } catch (err) {
        useVoice.getState().setError(`Transcription failed: ${String(err)}`);
      } finally {
        setTranscribing(false);
        focusTerminal(chat.id);
      }
      return;
    }
    try {
      stopSpeaking();
      await dictation.start(chat.id);
    } catch (err) {
      useVoice.getState().setError(`Microphone unavailable: ${String(err)}`);
    }
  };

  const exited = runtime && !runtime.running && (runtime.exitCode !== null || runtime.notStarted);

  return (
    <section
      className={`chat-pane terminal-pane kind-${kind} variant-${variant}${focused ? " focused" : ""}${chat.collapsed ? " collapsed" : ""}${
        runtime?.attention ? " attention" : ""
      }`}
      data-session-id={chat.id}
      onPointerDownCapture={() => !focused && focusChat(chat.id)}
      aria-label={chat.title}
    >
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="terminal" size={22} />
          <span>Drop to type the file path</span>
        </div>
      )}
      <header className="pane-head">
        <div className="pane-row">
          <span className="pane-index">{String(index + 1).padStart(2, "0")}</span>
          {editing ? (
            <input
              className="pane-title-input"
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setDraftTitle(chat.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <h2
              className="pane-title"
              title={`${chat.title}${runtime?.appTitle ? ` — ${runtime.appTitle}` : ""} · double-click to rename`}
              onDoubleClick={() => {
                setDraftTitle(chat.title);
                setEditing(true);
              }}
            >
              {chat.title}
            </h2>
          )}
          <SessionStatusPill chat={chat} />
          <ChatControls chat={chat} focusAction={variant === "card" ? "expand" : "dock"} />
        </div>
        <div className="pane-row pane-sub">
          <span className={`kind-badge kind-${kind}`}>
            <Icon name={kind === "claude" ? "spark" : "terminal"} size={11} /> {KIND_LABEL[kind]}
          </span>
          <span className="folder-chip" title={chat.cwd ?? "~"}>
            <Icon name="folder" size={11} /> {shortPath(chat.cwd)}
          </span>
          {kind === "command" && chat.command && (
            <code className="pane-command" title={chat.command}>
              {chat.command}
            </code>
          )}
          <span className="term-stats" title="Foreground program · CPU · memory of the whole session">
            {runtime?.foreground && <span className="term-proc">{runtime.foreground}</span>}
            {runtime?.running && (
              <span>
                {runtime.cpu.toFixed(0)}% · {runtime.memoryMb >= 1024 ? `${(runtime.memoryMb / 1024).toFixed(1)} GB` : `${Math.round(runtime.memoryMb)} MB`}
              </span>
            )}
          </span>
        </div>
        {!chat.collapsed && (
          <div className="pane-row pane-usage term-toolbar">
            {kind === "claude" ? <ClaudeUsageRow /> : <span className="usage-text muted">{runtime?.appTitle || " "}</span>}
            <span className="pane-spacer" />
            {kind === "claude" && (
              <button
                className="ctl wide"
                title="Past Claude Code sessions in this folder"
                onClick={() => useSessionPanel.getState().open({ mode: "resume", cwd: chat.cwd, kind: "claude" })}
              >
                <Icon name="history" size={12} /> Sessions
              </button>
            )}
            <button className="ctl" title="Search output (⌘F)" aria-pressed={searchOpen} onClick={() => setSearchOpen((o) => !o)}>
              <Icon name="search" size={12} />
            </button>
            <button className="ctl" title="Copy the whole session as text" onClick={() => void copyLog()}>
              <Icon name="copy" size={12} />
            </button>
            <button className="ctl" title="Save session log…" onClick={() => void saveLog()}>
              <Icon name="download" size={12} />
            </button>
            <button
              className={`ctl${dictating ? " recording" : ""}`}
              title={dictating ? "Stop dictation and type it" : "Dictate into the terminal"}
              disabled={transcribing || (dictatingChatId !== null && !dictating)}
              onClick={() => void toggleDictation()}
            >
              {transcribing ? <span className="spinner small" /> : <Icon name="mic" size={12} />}
            </button>
            {exited ? (
              <button className="ctl wide" title="Start the session again" onClick={() => restartTerminal(chat)}>
                <Icon name="refresh" size={12} /> {runtime?.notStarted ? "Run" : "Restart"}
              </button>
            ) : (
              <button className="ctl" title="Interrupt (Ctrl-C)" onClick={() => void ptySignal(chat.id, "INT").catch(() => writeToTerminal(chat.id, "\x03"))}>
                <Icon name="stop" size={12} />
              </button>
            )}
          </div>
        )}
      </header>

      {!chat.collapsed && searchOpen && (
        <div className="term-search">
          <Icon name="search" size={12} />
          <input
            ref={searchRef}
            value={query}
            placeholder="Find in output"
            onChange={(e) => {
              setQuery(e.target.value);
              searchTerminal(chat.id, e.target.value, "next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchTerminal(chat.id, query, e.shiftKey ? "previous" : "next");
              if (e.key === "Escape") {
                e.stopPropagation();
                setSearchOpen(false);
                focusTerminal(chat.id);
              }
            }}
          />
          <button className="ctl" title="Previous (⇧↩)" onClick={() => searchTerminal(chat.id, query, "previous")}>
            <Icon name="chevronUp" size={12} />
          </button>
          <button className="ctl" title="Next (↩)" onClick={() => searchTerminal(chat.id, query, "next")}>
            <Icon name="chevron" size={12} />
          </button>
          <button className="ctl" title="Close search" onClick={() => setSearchOpen(false)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {!chat.collapsed && (
        <div
          className="terminal-body"
          ref={containerRef}
          onKeyDownCapture={(e) => {
            if (e.metaKey && e.key.toLowerCase() === "f") {
              e.preventDefault();
              setSearchOpen(true);
            }
          }}
        />
      )}
    </section>
  );
}
