import { useEffect, useLayoutEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { MessageView } from "./MessageView";

/** Scroll container that follows new output unless the user has scrolled away from the bottom. */
export function MessageList({ messages, empty }: { messages: ChatMessage[]; empty: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const last = messages[messages.length - 1];
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.error]);

  return (
    <div className="message-list" ref={ref}>
      {messages.length === 0 ? empty : messages.map((m) => <MessageView key={m.id} message={m} />)}
    </div>
  );
}
