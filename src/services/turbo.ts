import { audioEngine } from "../audio/engine";
import { uid } from "../lib/ids";
import { liveCancel, livePrepare, liveTurn, type LiveConfig } from "../lib/ipc";
import { userTimeZone } from "../providers/agent/liveTools";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import { useVault } from "../store/vault";
import { useVoice } from "../store/voice";

/**
 * Turbo replies (Settings → Voice, off by default). Gemini Live speaks conversational answers
 * faster than the normal path. It only ever receives text E.V already heard and checked on this
 * Mac — never microphone audio, so the wake phrase, the passphrase and side conversations stay
 * local. Anything needing a tool is handed back to the normal path with all approval rules.
 * When Google's free limit is reached (or Live fails), E.V quietly uses the normal path.
 */

const PAUSE_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** No sound or hand-off this soon: don't keep the user waiting, use the normal path. */
const FIRST_SOUND_TIMEOUT_MS = 3_500;
let pausedUntil = 0;
let keyIndex = 0;

export function turboEnabled(): boolean {
  const { voice, providers } = useSettings.getState().settings;
  return voice.turbo && providers.gemini.keys.length > 0 && Date.now() >= pausedUntil;
}

function config(): LiveConfig {
  const { voice, providers } = useSettings.getState().settings;
  const keys = providers.gemini.keys;
  const now = new Date();
  const memories = useVault
    .getState()
    // Secrets are never saved as memories (the remember tool refuses them).
    .memories.filter((m) => m.scope === "gideon")
    .map((m) => `- ${m.text}`)
    .join("\n");
  const system = [
    "You are E.V, the user's personal AI on their Mac: calm, warm, precise and brief, like a ship's AI.",
    "You are speaking out loud. Answer in one to three short, natural sentences. No lists, markdown or emoji.",
    `It is ${now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} (${userTimeZone()}).`,
    "Only answer from general knowledge and the conversation. For anything that needs an action or fresh information, call hand_off and say nothing.",
    "Never handle money, payments or passwords.",
    memories ? `What you know about the user:\n${memories}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { key: keys[keyIndex % keys.length].key, model: voice.turboModel, voice: voice.turboVoice, system };
}

/** "Hey E.V" was heard: open a Live session now so the reply can start at once. */
export function prepareTurbo(): void {
  if (turboEnabled()) void livePrepare(config()).catch(() => {});
}

function pause(reason: string): void {
  pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
  keyIndex++;
  useVault.getState().logActivity({ at: Date.now(), chat: "Voice", tool: "turbo", title: "Turbo replies paused for 30 minutes", outcome: "ignored", detail: reason.slice(0, 200) });
}

/**
 * Answers `text` out loud with Gemini Live. Resolves true when it answered; false when the
 * request needs E.V's tools or Live isn't available — then send it the normal way.
 */
export async function turboReply(chatId: string, text: string): Promise<boolean> {
  const chat = useChats.getState().chats.find((c) => c.id === chatId);
  if (!chat || chat.kind !== "ai" || !turboEnabled()) return false;
  const history = chat.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() && !m.divider)
    .slice(-10)
    .map((m) => ({ role: m.role, text: m.content }));

  const live = config();
  const player = audioEngine.streamPcm();
  let said = "";
  let sounded = false;
  let handedOff = false;
  let stopped = false;
  const voice = useVoice.getState();
  const unsubscribe = useVoice.subscribe((state, previous) => {
    // Interrupted ("Hey E.V, stop", the orb): E.V's voice was stopped elsewhere.
    if (previous.speaking && !state.speaking && sounded) stopped = true;
  });
  const timeout = setTimeout(() => {
    if (!sounded && !handedOff) void liveCancel();
  }, FIRST_SOUND_TIMEOUT_MS);

  try {
    await liveTurn(live, history, text, (event) => {
      if (event.kind === "handoff") handedOff = true;
      else if (event.kind === "audio" && !stopped) {
        if (!sounded) voice.setSpeaking(true);
        sounded = true;
        player.push(event.data);
      } else if (event.kind === "text") said += event.text;
    });
  } catch (err) {
    pause(String(err));
    if (!sounded) return false;
  } finally {
    clearTimeout(timeout);
  }
  if (handedOff || !sounded) {
    await player.finish();
    unsubscribe();
    return false;
  }

  const now = Date.now();
  const store = useChats.getState();
  store.appendMessage(chatId, { id: uid("m-"), role: "user", content: text, createdAt: now });
  store.appendMessage(chatId, {
    id: uid("m-"),
    role: "assistant",
    content: said.trim().replace(/\s+/g, " "),
    createdAt: now,
    model: { provider: "gemini", model: live.model },
  });
  await player.finish();
  unsubscribe();
  if (!stopped) useVoice.getState().setSpeaking(false);
  return true;
}

/** Stops a Live reply that's still arriving (interrupted, or Talk mode ended). */
export function stopTurbo(): void {
  void liveCancel().catch(() => {});
}
