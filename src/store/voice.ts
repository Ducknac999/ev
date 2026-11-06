import { create } from "zustand";
import { persist } from "zustand/middleware";

export type InteractionMode = "text" | "talk";
export type ListenState = "off" | "listening" | "capturing" | "transcribing";

interface VoiceState {
  /** "talk" while one chat has the microphone (`talkChatId`). */
  mode: InteractionMode;
  /** The one chat in Talk mode: everything said goes there, whatever is clicked. Never restored after a restart. */
  talkChatId: string | null;
  /** Per chat: read its replies aloud (set in the chat's header). */
  speakers: Record<string, boolean>;
  /** The Talk chat's speaker setting from before Talk turned it on, put back when Talk ends. */
  speakerBeforeTalk: boolean | null;
  speaking: boolean;
  /** Mute E.V (top bar): nothing is spoken; everything shows in the notch instead. */
  muted: boolean;
  setMuted: (muted: boolean) => void;
  listen: ListenState;
  /** Chat currently dictating via the composer microphone button. */
  dictatingChatId: string | null;
  error: string | null;
  /** In a "Hey E.V" conversation: replies don't need the wake phrase. */
  engaged: boolean;
  setEngaged: (engaged: boolean) => void;
  setMode: (mode: InteractionMode) => void;
  /** Gives the microphone to `chatId` (or to nobody). */
  setTalkChat: (chatId: string | null) => void;
  setSpeaker: (chatId: string, on: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  setListen: (listen: ListenState) => void;
  setDictating: (chatId: string | null) => void;
  setError: (error: string | null) => void;
}

export const useVoice = create<VoiceState>()(
  persist(
    (set, get) => ({
      mode: "text",
      talkChatId: null,
      speakers: {},
      speakerBeforeTalk: null,
      speaking: false,
      muted: false,
      setMuted: (muted) => set({ muted }),
      listen: "off",
      dictatingChatId: null,
      error: null,
      engaged: false,
      setEngaged: (engaged) => set({ engaged }),
      setMode: (mode) => set(mode === "text" ? { mode, talkChatId: null } : { mode }),
      setTalkChat: (chatId) => {
        const { talkChatId, speakers, speakerBeforeTalk } = get();
        if (chatId === talkChatId) return;
        const next = { ...speakers };
        // Talk turns the speaker on for its chat; leaving Talk puts it back how it was.
        if (talkChatId) next[talkChatId] = speakerBeforeTalk ?? false;
        let before: boolean | null = null;
        if (chatId) {
          before = next[chatId] ?? false;
          next[chatId] = true;
        }
        set({ talkChatId: chatId, speakers: next, speakerBeforeTalk: before, mode: chatId ? "talk" : "text" });
      },
      setSpeaker: (chatId, on) => set((s) => ({ speakers: { ...s.speakers, [chatId]: on } })),
      setSpeaking: (speaking) => set({ speaking }),
      setListen: (listen) => set({ listen }),
      setDictating: (dictatingChatId) => set({ dictatingChatId }),
      setError: (error) => set({ error }),
    }),
    {
      name: "gideon.voice",
      version: 2,
      // Speaker choices are remembered; Talk (the microphone) never comes back on by itself.
      partialize: (s) => ({ speakers: s.speakers, muted: s.muted }),
      migrate: () => ({ speakers: {}, muted: false }),
    },
  ),
);

/** Whether this chat's replies are read aloud. */
export function speakerOn(chatId: string): boolean {
  return useVoice.getState().speakers[chatId] === true;
}

/** How many of these chats read replies aloud (replies get the chat's name when it's more than one). */
export function speakingChats(chatIds: string[]): number {
  const { speakers } = useVoice.getState();
  return chatIds.filter((id) => speakers[id] === true).length;
}

/** The orb shows in Talk mode, and whenever a reply is being read aloud. */
export function orbShouldShow(mode: InteractionMode, speaking: boolean): boolean {
  return mode === "talk" || speaking;
}
