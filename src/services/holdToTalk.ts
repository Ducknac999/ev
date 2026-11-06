import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { pttConfigure } from "../lib/ipc";
import { activeChats, useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import { isRunning, sendMessage } from "./chatRunner";
import { dictateIntoPanel } from "./quickPanel";
import { sayLastIfAsked } from "./announce";

/**
 * Hold to talk: hold the shortcut in any app, speak, let go — the words go to E.V's most recent
 * chat and the job runs there. The key, the microphone and the transcription are native
 * (src-tauri/src/ptt.rs), and the Vorssaint notch shows what's heard; this side sends the text.
 * The answer is spoken, or shown in the notch while something is playing (see announce).
 */

/** Why hold to talk couldn't start (shown under the setting), or null. */
export const useHoldToTalk = create<{ error: string | null }>(() => ({ error: null }));

let started = false;

/** The chat you were in, else the AI chat used last, else a new one. A busy chat gets a new one beside it. */
function targetChat(): string {
  const { chats, focusedChatId } = useChats.getState();
  const ai = activeChats(chats).filter((c) => c.kind === "ai" && !c.paused);
  const chat = ai.find((c) => c.id === focusedChatId) ?? [...ai].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (chat && !isRunning(chat.id)) return chat.id;
  return useChats.getState().createChat(useSettings.getState().settings);
}

/** Keeps the native shortcut in step with Settings → Voice and sends what it heard. */
export function startHoldToTalk(): void {
  if (started) return;
  started = true;
  const apply = () => {
    const { enabled, shortcut } = useSettings.getState().settings.voice.holdToTalk;
    void pttConfigure(enabled, shortcut)
      .then(() => useHoldToTalk.setState({ error: null }))
      .catch((err) => {
        const message = String(err);
        useHoldToTalk.setState({
          error: message.includes("PERMISSION:accessibility")
            ? "macOS needs to let E.V watch the keyboard for this: System Settings → Privacy & Security → Accessibility (and Input Monitoring) → turn on E.V."
            : message,
        });
      });
  };
  apply();
  useSettings.subscribe((state, previous) => {
    if (state.settings.voice.holdToTalk !== previous.settings.voice.holdToTalk) apply();
  });
  void listen<string>("ptt-text", (event) => {
    const text = event.payload.trim();
    if (!text) return;
    // With the quick panel open, the words go into its box to check before sending.
    if (dictateIntoPanel(text)) return;
    if (sayLastIfAsked(text)) return;
    const { speak } = useSettings.getState().settings.voice.holdToTalk;
    void sendMessage(targetChat(), text, { speak: false, announce: speak ? "hold" : "quiet" });
  }).catch(() => {});
}
