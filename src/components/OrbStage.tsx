import { useEffect, useState } from "react";
import { exitTalkMode, stopSpeaking } from "../services/voiceControl";
import { useChats } from "../store/chats";
import { orbShouldShow, useVoice } from "../store/voice";
import { Icon } from "./Icon";
import { Orb } from "./Orb";

const FADE_MS = 600;

/**
 * Talk mode: a docked stage under the workspace with the orb always visible, naming the chat that
 * has the microphone. Otherwise a floating orb appears only while a reply is read aloud, then fades.
 */
export function OrbStage() {
  const mode = useVoice((s) => s.mode);
  const speaking = useVoice((s) => s.speaking);
  const listen = useVoice((s) => s.listen);
  const engaged = useVoice((s) => s.engaged);
  const talkChatId = useVoice((s) => s.talkChatId);
  const talkTitle = useChats((s) => s.chats.find((c) => c.id === talkChatId)?.title);
  const show = orbShouldShow(mode, speaking);

  const [mounted, setMounted] = useState(show);
  const [visible, setVisible] = useState(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [show]);

  if (mode === "talk") {
    const status = speaking
      ? "Speaking — click the orb or press Esc to interrupt"
      : listen === "capturing"
        ? "Listening…"
        : listen === "transcribing"
          ? "Transcribing on Metal…"
          : talkTitle
            ? `Talking to ${talkTitle}`
            : "Press Talk in a chat to start talking";
    return (
      <div className={`orb-dock${visible ? " visible" : ""}`}>
        <button className={`orb-button${engaged || speaking ? " engaged" : " idle"}`} onClick={() => speaking && stopSpeaking()} aria-label="Voice orb">
          <Orb size={150} running={mounted} />
        </button>
        <div className="orb-dock-info">
          <div className={`orb-status state-${speaking ? "speaking" : listen}`}>{status}</div>
          <button className="btn ghost small" onClick={exitTalkMode}>
            <Icon name="close" size={12} /> Stop talking
          </button>
        </div>
      </div>
    );
  }

  if (!mounted) return null;
  return (
    <button
      className={`orb-float${visible ? " visible" : ""}`}
      onClick={stopSpeaking}
      title="Speaking — click or press Esc to stop"
      aria-label="Stop speaking"
    >
      <Orb size={132} running={mounted} />
    </button>
  );
}
