import { useEffect, useRef, useState } from "react";
import { enterTalkMode, exitTalkMode } from "../services/voiceControl";
import { useChats } from "../store/chats";
import { useVoice } from "../store/voice";
import type { Chat } from "../types";
import { Icon } from "./Icon";

/**
 * A chat's own voice controls. Text | Talk: Talk gives this chat the microphone — only one chat
 * can have it, so taking it from another asks first. Speaker: read this chat's replies aloud
 * (any number of chats can have it on; they take turns).
 */
export function VoiceButtons({ chat }: { chat: Chat }) {
  const talkChatId = useVoice((s) => s.talkChatId);
  const talking = talkChatId === chat.id;
  const otherTitle = useChats((s) => (talkChatId && talkChatId !== chat.id ? s.chats.find((c) => c.id === talkChatId)?.title : undefined));
  const [asking, setAsking] = useState(false);

  const talk = () => {
    if (talking) return;
    if (otherTitle) setAsking(true);
    else void enterTalkMode(chat.id);
  };


  return (
    <>
      <div className="segmented voice-mode" role="group" aria-label="Text or talk">
        <button className={talking ? "" : "active"} onClick={() => talking && exitTalkMode()} aria-pressed={!talking} title="Text: type only">
          Text
        </button>
        <button className={talking ? "active talk" : ""} onClick={talk} aria-pressed={talking} title="Talk: speak to this chat (you can still type)">
          <Icon name="mic" size={11} /> Talk
        </button>
      </div>
      {asking && otherTitle && <SwitchTalk from={otherTitle} to={chat.title} onCancel={() => setAsking(false)} onSwitch={() => (setAsking(false), void enterTalkMode(chat.id))} />}
    </>
  );
}

function SwitchTalk({ from, to, onCancel, onSwitch }: { from: string; to: string; onCancel: () => void; onSwitch: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="talk-switch-title">
        <h3 id="talk-switch-title">Switch Talk to this chat?</h3>
        <p>
          <b>{from}</b> is in Talk mode. Only one chat can listen at a time, so <b>{from}</b> goes back to Text and <b>{to}</b> gets the microphone.
        </p>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn neon" onClick={onSwitch}>
            Switch
          </button>
        </div>
      </div>
    </div>
  );
}
