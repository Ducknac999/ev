import { useEffect, useMemo, useRef, useState } from "react";
import { unsupportedReason } from "../lib/attachments";
import { GEMINI_FLASH, modelLabel } from "../providers/catalog";
import { dictation, stopSpeaking } from "../services/voiceControl";
import { sendMessage, stopGeneration } from "../services/chatRunner";
import { useChats } from "../store/chats";
import { useDrafts, type DraftItem } from "../store/drafts";
import { useSettings } from "../store/settings";
import { speakerOn, useVoice } from "../store/voice";
import { useSessionPanel } from "../store/sessionPanel";
import type { Chat } from "../types";
import { DraftAttachments } from "./Attachments";
import { Icon } from "./Icon";

const NO_DRAFTS: DraftItem[] = [];

export function Composer({ chat, focused }: { chat: Chat; focused: boolean }) {
  const [text, setText] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dictatingChatId = useVoice((s) => s.dictatingChatId);
  const setVoiceError = useVoice((s) => s.setError);
  const drafts = useDrafts((s) => s.byChat[chat.id] ?? NO_DRAFTS);
  const geminiKeys = useSettings((s) => s.settings.providers.gemini.keys.length);
  const dictating = dictatingChatId === chat.id;
  const streaming = chat.status === "streaming";
  const disabled = !!chat.paused;

  const ready = drafts.filter((d) => d.status === "ready" && d.attachment);
  const uploading = drafts.some((d) => d.status === "uploading");
  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of drafts) {
      const reason = d.attachment && unsupportedReason(chat.model, d.attachment);
      if (reason) map.set(d.id, reason);
    }
    return map;
  }, [drafts, chat.model]);
  // A model that can read every attached file, offered when the current one can't.
  const alternative = useMemo(() => {
    if (problems.size === 0) return null;
    const files = ready.map((d) => d.attachment!);
    const fits = geminiKeys > 0 && chat.model.provider !== "gemini" && files.every((a) => !unsupportedReason(GEMINI_FLASH, a));
    return fits ? GEMINI_FLASH : null;
  }, [problems, ready, geminiKeys, chat.model.provider]);

  const canSend = !disabled && !uploading && problems.size === 0 && (text.trim().length > 0 || ready.length > 0);

  useEffect(() => {
    if (focused && !disabled) ref.current?.focus({ preventScroll: true });
  }, [focused, disabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => () => {
    if (useVoice.getState().dictatingChatId === chat.id) dictation.cancel();
  }, [chat.id]);

  const submit = () => {
    const command = text.trim().toLowerCase();
    // E.V's session commands, the same ones Claude Code has.
    if (command === "/clear" && ready.length === 0) {
      if (streaming) return;
      useChats.getState().clearContext(chat.id);
      setText("");
      return;
    }
    if (command === "/resume") {
      useSessionPanel.getState().open({ mode: "new", kind: "ai", cwd: chat.cwd });
      setText("");
      return;
    }
    if (!canSend || streaming) return;
    const attachments = useDrafts.getState().take(chat.id);
    void sendMessage(chat.id, text, { speak: speakerOn(chat.id), attachments });
    setText("");
  };

  const attach = (files: FileList | File[] | null) => {
    if (!files || disabled) return;
    const list = [...files];
    if (list.length) useDrafts.getState().add(chat.id, list);
  };

  const toggleDictation = async () => {
    if (dictating) {
      setTranscribing(true);
      try {
        const transcript = await dictation.stop();
        if (transcript) setText((t) => (t.trim() ? `${t.trimEnd()} ${transcript}` : transcript));
      } catch (err) {
        setVoiceError(`Transcription failed: ${String(err)}`);
      } finally {
        setTranscribing(false);
        ref.current?.focus();
      }
      return;
    }
    try {
      stopSpeaking();
      await dictation.start(chat.id);
    } catch (err) {
      setVoiceError(`Microphone unavailable: ${String(err)}`);
    }
  };

  const firstProblem = problems.values().next().value;

  return (
    <div className="composer-wrap">
      {drafts.length > 0 && (
        <DraftAttachments items={drafts} problems={problems} onRemove={(id) => useDrafts.getState().remove(chat.id, id)} />
      )}
      {firstProblem && (
        <div className="attach-warning" role="alert">
          <Icon name="alert" size={12} />
          <span>{firstProblem}.</span>
          {alternative && (
            <button className="btn neon small" onClick={() => useChats.getState().requestModel(chat.id, alternative)}>
              Switch to {modelLabel(alternative)}
            </button>
          )}
        </div>
      )}
      <div className={`composer${disabled ? " disabled" : ""}`}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? "Read-only — pick a model to resume"
              : dictating
                ? "Listening… click the mic to finish"
                : `Message ${chat.title} — /plan · /compact · /clear · /resume · update`
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length === 0) return;
            attach(files);
            // Keep normal text pastes working; only swallow pastes that were purely files.
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-actions">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="icon-btn"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
            title="Attach files — or drag them onto the chat, or paste a screenshot"
            aria-label="Attach files"
          >
            <Icon name="clip" />
          </button>
          <button
            className={`icon-btn${dictating ? " recording" : ""}`}
            onClick={toggleDictation}
            disabled={disabled || transcribing || (dictatingChatId !== null && !dictating)}
            title={dictating ? "Stop dictation and transcribe" : "Dictate (whisper.cpp)"}
            aria-pressed={dictating}
          >
            {transcribing ? <span className="spinner" /> : <Icon name="mic" />}
          </button>
          {streaming ? (
            <button className="icon-btn primary" onClick={() => stopGeneration(chat.id)} title="Stop (⌘.)">
              <Icon name="stop" />
            </button>
          ) : (
            <button
              className="icon-btn primary"
              onClick={submit}
              disabled={!canSend}
              title={uploading ? "Waiting for attachments…" : firstProblem ? "Remove or switch model to send" : "Send (Enter)"}
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
