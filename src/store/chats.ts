import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { checkAssignment, lockHolder } from "../lib/locks";
import { uid } from "../lib/ids";
import { DEEPSEEK_FLASH, pickFallback, PROVIDERS, sameModel, upgradeModel } from "../providers/catalog";
import type { Chat, ChatMessage, LayoutMode, LockConflict, MessageBlock, ModelRef, SessionKind, Settings, ToolStep } from "../types";

export interface NewSession {
  kind: SessionKind;
  cwd?: string;
  command?: string;
  title?: string;
  model?: ModelRef;
  claudeSessionId?: string;
  /** Create without moving focus (e.g. sessions opened from the notch). */
  background?: boolean;
}

export const FOCUS_LIMIT = 4;

export type CloseOutcome = "deleted" | "archived" | "missing";

interface ChatsState {
  chats: Chat[];
  focusedChatId: string | null;
  layout: LayoutMode;
  /** Chats shown side by side in focus layout (max FOCUS_LIMIT), oldest first. */
  focusSet: string[];
  conflict: LockConflict | null;
  /** Chat awaiting hard-delete confirmation. */
  pendingDeleteId: string | null;

  createChat: (settings: Settings) => string;
  /** Creates any kind of session; AI chats take the default model unless one is given. */
  createSession: (settings: Settings, options: NewSession) => string;
  /** Empty chats are deleted outright; chats with history move to the Closed Chats drawer. */
  closeChat: (id: string) => CloseOutcome;
  restoreChat: (id: string) => void;
  deleteChat: (id: string) => void;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  focusChat: (id: string) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  renameChat: (id: string, title: string) => void;
  /** A name E.V gave the chat from what it's about; never over one the user chose. */
  setAiTitle: (id: string, title: string) => void;
  /** Undoes the user's own name so E.V names the chat again. */
  letGideonName: (id: string) => void;
  setLayout: (layout: LayoutMode) => void;
  /** Switches to focus layout with this chat on screen. */
  openInFocus: (id: string) => void;
  removeFromFocus: (id: string) => void;

  /** Requests a model for a chat; raises a conflict when the model is locked elsewhere. */
  requestModel: (chatId: string, model: ModelRef) => void;
  resolveConflictTransfer: () => string | null;
  resolveConflictFallback: (settings: Settings) => void;
  dismissConflict: () => void;

  appendMessage: (chatId: string, message: ChatMessage) => void;
  patchMessage: (chatId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  appendToMessage: (chatId: string, messageId: string, text: string) => void;
  setStatus: (chatId: string, status: Chat["status"]) => void;
  setClaudeSession: (chatId: string, sessionId: string | undefined) => void;
  addBlock: (chatId: string, messageId: string, block: MessageBlock) => void;
  patchStep: (chatId: string, messageId: string, stepId: string, patch: Partial<ToolStep>) => void;
  /** /clear: start a fresh model context from the next message, leaving history visible. */
  clearContext: (chatId: string) => void;
  setCwd: (chatId: string, cwd: string) => void;
  /** Pins an API key to the chat; `undefined` returns it to automatic selection. */
  pinKey: (chatId: string, keyId: string | undefined) => void;
  setThinking: (chatId: string, on: boolean) => void;
  setLastKey: (chatId: string, keyId: string) => void;
  setWorkspace: (chatId: string, workspace: Chat["workspace"]) => void;
  /** Folds earlier conversation into a summary (auto or /compact); `marker` adds a visible divider. */
  setCompact: (chatId: string, compact: Chat["compact"], marker?: boolean) => void;
  /** Removes messages (e.g. a half-heard request that was joined into a longer one). */
  dropMessages: (chatId: string, ids: string[]) => void;
}

export const activeChats = (chats: Chat[]) => chats.filter((c) => !c.archived);
export const archivedChats = (chats: Chat[]) =>
  chats.filter((c) => c.archived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

export function hasHistory(chat: Chat): boolean {
  // Terminal sessions always keep a history entry so they can be reopened, like ClaudeDesk.
  if (chat.kind !== "ai") return true;
  return chat.messages.some((m) => m.role === "user" || m.content.trim().length > 0);
}

const SESSION_TITLES: Record<Exclude<SessionKind, "ai">, string> = { claude: "Claude", codex: "Codex", shell: "Terminal", command: "Command", browser: "E.V Browser" };

export function folderName(cwd: string | undefined): string {
  if (!cwd) return "~";
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.split("/").pop() || "/";
}

/** Lowest positive number not used by an active chat, so numbering restarts at 1 once cleared. */
export function nextSeq(chats: Chat[]): number {
  const used = new Set(activeChats(chats).map((c) => c.seq));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function addToFocus(focusSet: string[], id: string): string[] {
  if (focusSet.includes(id)) return focusSet;
  const next = [...focusSet, id];
  return next.length > FOCUS_LIMIT ? next.slice(next.length - FOCUS_LIMIT) : next;
}

const updateChat = (chats: Chat[], id: string, fn: (chat: Chat) => Chat): Chat[] =>
  chats.map((c) => (c.id === id ? fn(c) : c));

function withModel(chat: Chat, model: ModelRef): Chat {
  const sameProvider = chat.model.provider === model.provider;
  return {
    ...chat,
    model,
    paused: null,
    // Keys belong to one provider; a pin or preference means nothing after switching provider.
    pinnedKeyId: sameProvider ? chat.pinnedKeyId : undefined,
    lastKeyId: sameProvider ? chat.lastKeyId : undefined,
    claudeSessionId: chat.claudeSessionId,
  };
}

/** Next chat to focus after `removedId` leaves the workspace. */
function fallbackFocus(chats: Chat[], current: string | null, removedId: string): string | null {
  if (current !== removedId) return current;
  return activeChats(chats).filter((c) => c.id !== removedId && !c.collapsed).at(-1)?.id ?? null;
}

/** Removes a chat from workspace bookkeeping (focus set, focus, pending dialogs). */
function detach(s: ChatsState, chats: Chat[], id: string): Partial<ChatsState> {
  return {
    chats,
    focusSet: s.focusSet.filter((f) => f !== id),
    focusedChatId: fallbackFocus(s.chats, s.focusedChatId, id),
    pendingDeleteId: s.pendingDeleteId === id ? null : s.pendingDeleteId,
    conflict: s.conflict && [s.conflict.holderChatId, s.conflict.requestingChatId].includes(id) ? null : s.conflict,
  };
}

export const useChats = create<ChatsState>()(
  persist(
    (set, get) => ({
      chats: [],
      focusedChatId: null,
      layout: "hud",
      focusSet: [],
      conflict: null,
      pendingDeleteId: null,

      createChat: (settings) => get().createSession(settings, { kind: "ai" }),

      createSession: (settings, options) => {
        const { chats } = get();
        const seq = nextSeq(chats);
        const wanted = options.model ?? settings.defaultModel;
        const model = lockHolder(chats, wanted) ? pickFallback(settings) : wanted;
        const now = Date.now();
        const isTerminal = options.kind !== "ai";
        const title =
          options.title ??
          (isTerminal
            ? options.kind === "command"
              ? (options.command ?? "Command").slice(0, 40)
              : options.kind === "browser"
                ? SESSION_TITLES.browser
                : `${SESSION_TITLES[options.kind as Exclude<SessionKind, "ai">]} · ${folderName(options.cwd)}`
            : `Chat ${seq}`);
        const chat: Chat = {
          id: uid(options.kind === "browser" ? "web-" : isTerminal ? "term-" : "chat-"),
          kind: options.kind,
          cwd: options.cwd,
          command: options.command,
          claudeSessionId: options.claudeSessionId,
          title,
          titleIsCustom: isTerminal,
          model,
          messages: [],
          status: "idle",
          paused: null,
          collapsed: false,
          archived: false,
          seq,
          unseen: false,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          chats: [...s.chats, chat],
          focusedChatId: options.background ? s.focusedChatId : chat.id,
          focusSet: s.layout === "focus" && !options.background ? addToFocus(s.focusSet, chat.id) : s.focusSet,
        }));
        return chat.id;
      },

      closeChat: (id) => {
        const chat = get().chats.find((c) => c.id === id);
        if (!chat) return "missing";
        if (!hasHistory(chat)) {
          get().deleteChat(id);
          return "deleted";
        }
        set((s) =>
          detach(
            s,
            updateChat(s.chats, id, (c) => ({
              ...c,
              archived: true,
              archivedAt: Date.now(),
              collapsed: false,
              status: c.status === "streaming" ? "idle" : c.status,
            })),
            id,
          ),
        );
        return "archived";
      },

      restoreChat: (id) =>
        set((s) => {
          const chat = s.chats.find((c) => c.id === id);
          if (!chat?.archived) return {};
          // The lock may have moved on while archived: come back read-only instead of double-booking it.
          const holder = lockHolder(s.chats, chat.model, id);
          const restored: Chat = {
            ...chat,
            archived: false,
            archivedAt: undefined,
            collapsed: false,
            unseen: false,
            paused: holder ? { byChatId: holder.id, byChatTitle: holder.title, at: Date.now() } : chat.paused,
          };
          // Move to the end so it appears as the newest card.
          const chats = [...s.chats.filter((c) => c.id !== id), restored];
          return {
            chats,
            focusedChatId: id,
            focusSet: s.layout === "focus" ? addToFocus(s.focusSet, id) : s.focusSet,
          };
        }),

      deleteChat: (id) => set((s) => detach(s, s.chats.filter((c) => c.id !== id), id)),

      requestDelete: (id) => set({ pendingDeleteId: id }),
      cancelDelete: () => set({ pendingDeleteId: null }),

      focusChat: (id) =>
        set((s) => ({
          focusedChatId: id,
          chats: updateChat(s.chats, id, (c) => (c.unseen && !c.collapsed ? { ...c, unseen: false } : c)),
        })),

      setCollapsed: (id, collapsed) =>
        set((s) => ({
          chats: updateChat(s.chats, id, (c) => ({ ...c, collapsed, unseen: collapsed ? c.unseen : false })),
          focusedChatId: collapsed ? fallbackFocus(s.chats, s.focusedChatId, id) : id,
          // In focus layout a collapsed chat drops to the dock; expanding brings it back on screen.
          focusSet: collapsed
            ? s.focusSet.filter((f) => f !== id)
            : s.layout === "focus"
              ? addToFocus(s.focusSet, id)
              : s.focusSet,
        })),

      renameChat: (id, title) =>
        set((s) => ({
          chats: updateChat(s.chats, id, (c) => ({ ...c, title: title.trim() || c.title, titleIsCustom: true })),
        })),

      setAiTitle: (id, title) =>
        set((s) => ({
          chats: updateChat(s.chats, id, (c) => (c.titleIsCustom || !title.trim() ? c : { ...c, title: title.trim(), aiNamed: true })),
        })),

      letGideonName: (id) =>
        set((s) => ({ chats: updateChat(s.chats, id, (c) => ({ ...c, titleIsCustom: false, aiNamed: false })) })),

      setLayout: (layout) =>
        set((s) => {
          const live = activeChats(s.chats).filter((c) => !c.collapsed);
          if (layout !== "focus" || s.focusSet.some((id) => live.some((c) => c.id === id))) return { layout };
          // Entering focus with nothing pinned: seed with the focused chat.
          const seed = live.find((c) => c.id === s.focusedChatId)?.id ?? live[0]?.id;
          return { layout, focusSet: seed ? [seed] : [] };
        }),

      openInFocus: (id) =>
        set((s) => ({
          layout: "focus",
          focusedChatId: id,
          focusSet: addToFocus(s.focusSet, id),
          chats: updateChat(s.chats, id, (c) => ({ ...c, collapsed: false, unseen: false })),
        })),

      removeFromFocus: (id) =>
        set((s) => {
          const focusSet = s.focusSet.filter((f) => f !== id);
          return {
            focusSet,
            focusedChatId: s.focusedChatId === id ? (focusSet.at(-1) ?? s.focusedChatId) : s.focusedChatId,
          };
        }),

      requestModel: (chatId, model) => {
        const { chats } = get();
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return;
        if (sameModel(chat.model, model) && !chat.paused) return;
        const result = checkAssignment(chats, chatId, model);
        if (result.kind === "conflict") {
          set({ conflict: { requestingChatId: chatId, holderChatId: result.holderChatId, model } });
          return;
        }
        set({ chats: updateChat(chats, chatId, (c) => withModel(c, model)) });
      },

      resolveConflictTransfer: () => {
        const { conflict, chats } = get();
        if (!conflict) return null;
        const requester = chats.find((c) => c.id === conflict.requestingChatId);
        if (!requester) {
          set({ conflict: null });
          return null;
        }
        const next = chats.map((c) => {
          if (c.id === conflict.holderChatId) {
            return { ...c, paused: { byChatId: requester.id, byChatTitle: requester.title, at: Date.now() } };
          }
          if (c.id === conflict.requestingChatId) return withModel(c, conflict.model);
          return c;
        });
        set({ chats: next, conflict: null });
        return conflict.holderChatId;
      },

      resolveConflictFallback: (settings) => {
        const { conflict, chats } = get();
        if (!conflict) return;
        const fallback = pickFallback(settings);
        set({
          chats: updateChat(chats, conflict.requestingChatId, (c) => withModel(c, fallback)),
          conflict: null,
        });
      },

      dismissConflict: () => set({ conflict: null }),

      appendMessage: (chatId, message) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => {
            const autoTitle =
              !c.titleIsCustom && message.role === "user" && !c.messages.some((m) => m.role === "user")
                ? message.content.replace(/\s+/g, " ").trim().slice(0, 42) || message.attachments?.[0]?.name || c.title
                : c.title;
            return { ...c, title: autoTitle, messages: [...c.messages, message], updatedAt: Date.now() };
          }),
        })),

      patchMessage: (chatId, messageId, patch) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
          })),
        })),

      appendToMessage: (chatId, messageId, text) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({
            ...c,
            messages: c.messages.map((m) => {
              if (m.id !== messageId) return m;
              if (!m.blocks) return { ...m, content: m.content + text };
              const last = m.blocks.at(-1);
              const blocks: MessageBlock[] =
                last?.type === "text"
                  ? [...m.blocks.slice(0, -1), { type: "text", text: last.text + text }]
                  : [...m.blocks, { type: "text", text }];
              return { ...m, content: m.content + text, blocks };
            }),
          })),
        })),

      addBlock: (chatId, messageId, block) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({
            ...c,
            updatedAt: Date.now(),
            messages: c.messages.map((m) => (m.id === messageId ? { ...m, blocks: [...(m.blocks ?? []), block] } : m)),
          })),
        })),

      patchStep: (chatId, messageId, stepId, patch) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id !== messageId || !m.blocks
                ? m
                : {
                    ...m,
                    blocks: m.blocks.map((b) => (b.type === "tool" && b.step.id === stepId ? { ...b, step: { ...b.step, ...patch } } : b)),
                  },
            ),
          })),
        })),

      clearContext: (chatId) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => {
            const divider: ChatMessage = { id: uid("m-"), role: "assistant", content: "", createdAt: Date.now(), divider: "clear" };
            return { ...c, messages: [...c.messages, divider], contextStart: c.messages.length + 1, compact: undefined, aiNamed: false, updatedAt: Date.now() };
          }),
        })),

      setCwd: (chatId, cwd) => set((s) => ({ chats: updateChat(s.chats, chatId, (c) => ({ ...c, cwd })) })),

      setStatus: (chatId, status) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({
            ...c,
            status,
            updatedAt: status === c.status ? c.updatedAt : Date.now(),
            unseen:
              (c.collapsed || c.archived) && c.status === "streaming" && status !== "streaming" ? true : c.unseen,
          })),
        })),

      setClaudeSession: (chatId, sessionId) =>
        set((s) => ({ chats: updateChat(s.chats, chatId, (c) => ({ ...c, claudeSessionId: sessionId })) })),

      pinKey: (chatId, keyId) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => ({ ...c, pinnedKeyId: keyId, lastKeyId: keyId ?? c.lastKeyId })),
        })),

      setThinking: (chatId, on) => set((s) => ({ chats: updateChat(s.chats, chatId, (c) => ({ ...c, thinking: on })) })),

      dropMessages: (chatId, ids) =>
        set((s) => ({ chats: updateChat(s.chats, chatId, (c) => ({ ...c, messages: c.messages.filter((m) => !ids.includes(m.id)) })) })),

      setWorkspace: (chatId, workspace) => set((s) => ({ chats: updateChat(s.chats, chatId, (c) => ({ ...c, workspace })) })),

      setCompact: (chatId, compact, marker) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => {
            const divider: ChatMessage = { id: uid("m-"), role: "assistant", content: compact?.summary ?? "", createdAt: Date.now(), divider: "compact" };
            return { ...c, compact, messages: marker ? [...c.messages, divider] : c.messages, updatedAt: Date.now() };
          }),
        })),

      setLastKey: (chatId, keyId) =>
        set((s) => ({
          chats: updateChat(s.chats, chatId, (c) => (c.lastKeyId === keyId ? c : { ...c, lastKeyId: keyId })),
        })),
    }),
    {
      name: "gideon.workspace",
      version: 5,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        chats: s.chats,
        focusedChatId: s.focusedChatId,
        layout: s.layout,
        focusSet: s.focusSet,
      }),
      migrate: (persisted) => persisted as ChatsState,
      // Normalises older saves and settles in-flight state: streams never survive a restart.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ChatsState>;
        type Legacy = Chat & { minimized?: boolean };
        const chats = ((p.chats ?? []) as Legacy[]).map(({ minimized, ...c }, i) => {
          const seqFromTitle = /^Chat (\d+)$/.exec(c.title)?.[1];
          const kind: SessionKind = c.kind ?? "ai";
          const upgraded = upgradeModel(c.model, DEEPSEEK_FLASH);
          // Claude chats became Claude Code sessions; old ones continue as API-model chats and keep
          // their Claude session id so they can be reopened in Claude Code.
          const model = kind === "ai" && upgraded.provider === "claude" ? DEEPSEEK_FLASH : upgraded;
          const providerChanged = model.provider !== c.model?.provider;
          return {
            ...c,
            kind,
            model,
            claudeSessionId: c.claudeSessionId,
            paused: providerChanged ? null : c.paused,
            pinnedKeyId: providerChanged ? undefined : c.pinnedKeyId,
            lastKeyId: providerChanged ? undefined : c.lastKeyId,
            collapsed: c.collapsed ?? minimized ?? false,
            archived: c.archived ?? false,
            seq: c.seq ?? (seqFromTitle ? Number(seqFromTitle) : i + 1),
            updatedAt: c.updatedAt ?? c.messages.at(-1)?.createdAt ?? c.createdAt,
            status: c.status === "streaming" ? ("idle" as const) : c.status,
            messages: c.messages.map(({ model: messageModel, ...m }) => ({
              ...m,
              // Replies from removed providers keep their text but lose the model tag.
              ...(messageModel && messageModel.provider in PROVIDERS ? { model: messageModel } : {}),
              ...(m.pending ? { pending: false, error: m.error ?? (m.content ? undefined : "Interrupted") } : {}),
              // Cards from a turn that never finished can no longer be approved.
              ...(m.blocks?.some((b) => b.type === "tool" && ["pending", "queued", "running"].includes(b.step.status))
                ? {
                    blocks: m.blocks.map((b) =>
                      b.type === "tool" && ["pending", "queued", "running"].includes(b.step.status)
                        ? { ...b, step: { ...b.step, status: b.step.status === "running" ? ("error" as const) : ("denied" as const) } }
                        : b,
                    ),
                  }
                : {}),
            })),
          };
        });
        const layout: LayoutMode = p.layout && ["hud", "focus", "tray"].includes(p.layout) ? p.layout : "hud";
        const live = new Set(activeChats(chats).map((c) => c.id));
        const focusSet = (p.focusSet ?? []).filter((id) => live.has(id));
        const focusedChatId = p.focusedChatId && live.has(p.focusedChatId) ? p.focusedChatId : null;
        return { ...current, chats, layout, focusSet, focusedChatId };
      },
    },
  ),
);
