import { useMemo } from "react";
import { lastPreview, relativeTime } from "../lib/chatStatus";
import { useNow } from "../lib/useNow";
import { activeChats, archivedChats, FOCUS_LIMIT, useChats } from "../store/chats";
import { useSessionPanel } from "../store/sessionPanel";
import type { Chat } from "../types";
import { ChatControls } from "./ChatControls";
import { ChatPane, type PaneVariant } from "./ChatPane";
import { Icon, type IconName } from "./Icon";
import { useSettings } from "../store/settings";
import { SessionGlyph, sessionLabel, SessionStatusPill } from "./SessionStatus";
import { TerminalPane } from "./TerminalPane";
import { BrowserPane } from "./BrowserPane";

const pad = (n: number) => String(n).padStart(2, "0");

function SessionPane(props: { chat: Chat; index: number; focused: boolean; variant: PaneVariant }) {
  if (props.chat.kind === "browser") return <BrowserPane {...props} />;
  return props.chat.kind === "ai" ? <ChatPane {...props} /> : <TerminalPane {...props} />;
}

function EmptyWorkspace({ onOpenClosed }: { onOpenClosed: () => void }) {
  const allChats = useChats((s) => s.chats);
  const closed = useMemo(() => archivedChats(allChats), [allChats]);
  const agents = useSettings((s) => s.settings.agents);
  const open = useSessionPanel((s) => s.open);
  const restore = useChats((s) => s.restoreChat);
  const cards: { kind: "ai" | "claude" | "codex" | "shell"; title: string; about: string; icon: IconName }[] = [
    { kind: "ai", title: "E.V Chat", about: "Ask anything, or give E.V a task on your Mac. It asks before anything risky.", icon: "wave" },
    ...(agents.claude ? [{ kind: "claude" as const, title: "Claude Code", about: "Anthropic's coding agent, working in a project folder.", icon: "spark" as IconName }] : []),
    ...(agents.codex ? [{ kind: "codex" as const, title: "Codex", about: "OpenAI's coding agent, working in a project folder.", icon: "spark" as IconName }] : []),
    { kind: "shell", title: "Terminal", about: "Your normal Mac terminal, kept running in the background.", icon: "terminal" },
  ];
  return (
    <div className="home">
      <header className="home-head">
        <h1>What do you want to do?</h1>
        <p>Start a chat, a coding agent or a terminal. Everything stays on this Mac.</p>
      </header>
      <div className="home-grid">
        {cards.map((c) => (
          <button key={c.kind} className="home-card" onClick={() => open({ mode: "new", kind: c.kind })}>
            <span className="home-icon">
              <Icon name={c.icon} size={22} />
            </span>
            <h3>{c.title}</h3>
            <p>{c.about}</p>
          </button>
        ))}
        <button className={`home-card light${cards.length % 3 === 1 ? " wide" : ""}`} onClick={() => open({ mode: "new" })}>
          <span className="home-cta">
            New session <span className="home-cta-arrow">↗</span>
          </span>
          <p>Pick any kind of session and a project folder. Shortcut: ⌘N</p>
        </button>
      </div>
      {closed.length > 0 && (
        <section className="home-recent">
          <h4>Recently closed</h4>
          <div className="home-recent-row">
            {closed.slice(0, 8).map((c) => (
              <button key={c.id} className="home-chip" onClick={() => restore(c.id)}>
                {c.title} <span className="muted">{relativeTime(c.updatedAt, Date.now())}</span>
              </button>
            ))}
            {closed.length > 8 && (
              <button className="home-chip" onClick={onOpenClosed}>
                All {closed.length} closed
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Responsive card matrix: cards never shrink below 360px; the workspace scrolls vertically instead. */
function GridView({ chats, focusedChatId }: { chats: Chat[]; focusedChatId: string | null }) {
  return (
    <div className="workspace-scroll">
      <div className="hud-grid">
        {chats.map((chat, i) => (
          <SessionPane key={chat.id} chat={chat} index={i} focused={chat.id === focusedChatId} variant="card" />
        ))}
      </div>
    </div>
  );
}

/** Up to four chats side by side or 2x2; collapsed and background chats wait in the dock. */
function FocusView({ chats, focusedChatId }: { chats: Chat[]; focusedChatId: string | null }) {
  const focusSet = useChats((s) => s.focusSet);
  const expanded = chats.filter((c) => !c.collapsed);
  let focused = focusSet.map((id) => expanded.find((c) => c.id === id)).filter((c): c is Chat => !!c);
  if (focused.length === 0 && expanded.length > 0) {
    focused = [expanded.find((c) => c.id === focusedChatId) ?? expanded[0]];
  }
  const docked = chats.filter((c) => !focused.includes(c));

  // One session list for every layout: the sidebar (⌘B). Sessions not on screen wait there.
  return (
    <div className="focus-layout no-dock">
      {focused.length > 0 ? (
        <div className={`focus-grid count-${focused.length}`}>
          {focused.map((chat) => (
            <SessionPane key={chat.id} chat={chat} index={chats.indexOf(chat)} focused={chat.id === focusedChatId} variant="focus" />
          ))}
        </div>
      ) : (
        <div className="focus-placeholder">Everything is minimized — pick a session in the sidebar (⌘B)</div>
      )}
      {focused.length >= FOCUS_LIMIT && docked.length > 0 && (
        <div className="focus-hint">Focus shows up to {FOCUS_LIMIT} · opening another replaces the oldest</div>
      )}
    </div>
  );
}

/** Command-center rows for managing many sessions at once. */
function TrayView({ chats }: { chats: Chat[] }) {
  const now = useNow();
  const openInFocus = useChats((s) => s.openInFocus);
  const focusChat = useChats((s) => s.focusChat);
  return (
    <div className="workspace-scroll">
      <div className="tray" role="table" aria-label="Sessions">
        <div className="tray-row tray-header" role="row">
          <span role="columnheader">ID</span>
          <span role="columnheader">Session</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader">Updated</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="tray-actions-head">
            Controls
          </span>
        </div>
        {chats.map((chat, i) => (
          <div
            key={chat.id}
            className={`tray-row${chat.collapsed ? " is-collapsed" : ""}`}
            role="row"
            onClick={() => focusChat(chat.id)}
            onDoubleClick={() => openInFocus(chat.id)}
          >
            <span className="tray-id" role="cell">
              {pad(i + 1)}
            </span>
            <span className="tray-session" role="cell">
              <span className="tray-title" title={chat.title}>
                {chat.title}
              </span>
              <span className="tray-preview">{chat.collapsed ? "Minimized · " : ""}{lastPreview(chat)}</span>
            </span>
            <span role="cell" className="tray-model">
              <span className="model-tag">
                <SessionGlyph chat={chat} />
                <span className="model-tag-label">{sessionLabel(chat)}</span>
              </span>
            </span>
            <span className="tray-time" role="cell" title={new Date(chat.updatedAt).toLocaleString()}>
              {relativeTime(chat.updatedAt, now)}
            </span>
            <span role="cell">
              <SessionStatusPill chat={chat} />
            </span>
            <span className="tray-actions" role="cell" onClick={(e) => e.stopPropagation()}>
              <button className="btn small" onClick={() => openInFocus(chat.id)} title="Open in focus view">
                <Icon name="expand" size={12} /> Focus
              </button>
              <ChatControls chat={chat} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Workspace({ onOpenClosed }: { onOpenClosed: () => void }) {
  const all = useChats((s) => s.chats);
  const layout = useChats((s) => s.layout);
  const focusedChatId = useChats((s) => s.focusedChatId);
  const chats = activeChats(all);

  if (chats.length === 0) return <EmptyWorkspace onOpenClosed={onOpenClosed} />;
  if (layout === "tray") return <TrayView chats={chats} />;
  if (layout === "focus") return <FocusView chats={chats} focusedChatId={focusedChatId} />;
  return <GridView chats={chats} focusedChatId={focusedChatId} />;
}
