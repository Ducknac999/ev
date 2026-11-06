import { useState } from "react";
import { pickFolder } from "../lib/ipc";
import { canThink, modelLabel } from "../providers/catalog";
import { folderName, useChats } from "../store/chats";
import { useDropTarget } from "../store/dropTarget";
import { useSettings } from "../store/settings";
import type { Chat } from "../types";
import { ChatControls } from "./ChatControls";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { MessageList } from "./MessageList";
import { ModelPicker } from "./ModelPicker";
import { SessionStatusPill } from "./SessionStatus";
import { ChatUsageRow } from "./Usage";
import { VoiceButtons } from "./VoiceButtons";
import { HelpersBadge } from "./HelpersBadge";
import { nameChat } from "../services/chatNames";

export type PaneVariant = "card" | "focus";

export function ChatPane({
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
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(chat.title);
  const dropping = useDropTarget((s) => s.targetId === chat.id);
  const settings = useSettings((s) => s.settings);

  const changeFolder = async () => {
    const picked = await pickFolder(chat.cwd).catch(() => null);
    if (!picked) return;
    useChats.getState().setCwd(chat.id, picked.replace(/\/$/, "") || "/");
    useSettings.getState().rememberFolder(picked.replace(/\/$/, "") || "/");
  };

  const continueInClaude = () => {
    const id = useChats.getState().createSession(settings, {
      kind: "claude",
      cwd: settings.claude.cwd || "~",
      claudeSessionId: chat.claudeSessionId,
      title: `Claude · ${chat.title}`.slice(0, 48),
    });
    useChats.getState().focusChat(id);
  };

  const commitTitle = () => {
    setEditing(false);
    if (draftTitle.trim() && draftTitle !== chat.title) renameChat(chat.id, draftTitle);
  };

  const startRename = () => {
    setDraftTitle(chat.title);
    setEditing(true);
  };

  const letGideonName = () => {
    setEditing(false);
    useChats.getState().letGideonName(chat.id);
    void nameChat(chat.id);
  };

  return (
    <section
      className={`chat-pane variant-${variant}${focused ? " focused" : ""}${chat.paused ? " paused" : ""}${
        chat.status === "streaming" ? " streaming" : ""
      }${chat.collapsed ? " collapsed" : ""}`}
      onPointerDownCapture={() => !focused && focusChat(chat.id)}
      aria-label={chat.title}
      data-session-id={chat.id}
    >
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="clip" size={22} />
          <span>Drop to attach to {chat.title}</span>
        </div>
      )}
      <header className="pane-head">
        <div className="pane-row">
          <span className="pane-index" title={index < 9 ? `⌘${index + 1}` : undefined}>
            {String(index + 1).padStart(2, "0")}
          </span>
          {editing ? (
            <span className="pane-rename">
              <input
                className="pane-title-input"
                autoFocus
                value={draftTitle}
                placeholder="Name this chat"
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
              {chat.titleIsCustom && (
                // onMouseDown runs before the input's blur would save the typed name.
                <button className="link-btn" onMouseDown={(e) => (e.preventDefault(), letGideonName())} title="Forget your name and let E.V name it from the topic">
                  Let E.V name it
                </button>
              )}
            </span>
          ) : (
            <>
              <h2 className="pane-title" title={`${chat.title} — double-click to rename`} onDoubleClick={startRename}>
                {chat.title}
              </h2>
              <button className="icon-btn ghost small rename-btn" onClick={startRename} title="Rename this chat" aria-label="Rename this chat">
                <Icon name="edit" size={12} />
              </button>
            </>
          )}
          <HelpersBadge chat={chat} />
          <SessionStatusPill chat={chat} />
          <ChatControls chat={chat} focusAction={variant === "card" ? "expand" : "dock"} />
        </div>
        <div className="pane-row pane-sub">
          <ModelPicker chat={chat} />
          {chat.kind === "ai" && canThink(chat.model) && (
            <button
              className={`folder-chip think-chip${chat.thinking ? " on" : ""}`}
              onClick={() => useChats.getState().setThinking(chat.id, !chat.thinking)}
              aria-pressed={chat.thinking === true}
              title={chat.thinking ? "Thinking on: reasons before answering (slower, better on hard problems). Click to turn off." : "Thinking off: answers right away. Click to make it think first."}
            >
              <Icon name="spark" size={11} /> Think {chat.thinking ? "on" : "off"}
            </button>
          )}
          <VoiceButtons chat={chat} />
          <button className="folder-chip" onClick={() => void changeFolder()} title={`${chat.cwd ?? "No project folder (home)"} — click to change`}>
            <Icon name="folder" size={11} /> {chat.cwd ? folderName(chat.cwd) : "Choose folder"}
          </button>
          {chat.claudeSessionId && (
            <button className="folder-chip claude-link" onClick={continueInClaude} title="This was a Claude chat — reopen its Claude session in Claude Code">
              <Icon name="spark" size={11} /> Continue in Claude Code
            </button>
          )}
        </div>
        {!chat.collapsed && <ChatUsageRow chat={chat} />}
      </header>

      {!chat.collapsed && chat.paused && (
        <div className="paused-banner" role="status">
          <Icon name="pause" size={12} />
          <span>
            Paused · {modelLabel(chat.model)} moved to <strong>{chat.paused.byChatTitle}</strong>. Read-only — choose a
            model to resume.
          </span>
        </div>
      )}

      {!chat.collapsed && (
        <>
      <MessageList
        messages={chat.messages}
        empty={
          <div className="pane-empty">
            <div className="pane-empty-title">{modelLabel(chat.model)}</div>
            <div className="pane-empty-sub">Awaiting input</div>
          </div>
        }
      />

      <Composer chat={chat} focused={focused} />
        </>
      )}
    </section>
  );
}
