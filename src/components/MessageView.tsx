import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { modelLabel } from "../providers/catalog";
import { shortCount } from "../store/usage";
import { sendMessage } from "../services/chatRunner";
import { useChats } from "../store/chats";
import { useVault } from "../store/vault";
import type { ChatMessage } from "../types";
import { MessageAttachments } from "./Attachments";
import { ToolCard } from "./ToolCard";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";
import { ProviderDot } from "./ModelPicker";

const REMARK_PLUGINS = [remarkGfm, remarkMath];
// Maths written as $…$ / $$…$$ shows as real notation; bad LaTeX falls back to its source text.
const REHYPE_PLUGINS = [[rehypeKatex, { throwOnError: false, strict: "ignore" }], [rehypeHighlight, { detect: false, ignoreMissing: true }]] as const;

/** Show the typing dots while the model is producing its next step (not while a card waits). */
function thinking(message: ChatMessage): boolean {
  const last = message.blocks?.at(-1);
  if (!last) return !message.content;
  return last.type === "tool" && last.step.status !== "pending" && last.step.status !== "running";
}

/**
 * Prices ("$5 and $10") stay text, not maths; a formula alone on its line ($$…$$) shows full size.
 */
/** `$6.5\text{M} / 3$`: a $…$ span with a LaTeX command in it is math, even when it starts with a number. */
const LATEX_SPAN = /(?<!\$)\$(?![$\s])[^$\n]*?\\[a-zA-Z]+[^$\n]*?\$(?!\$)/g;

export function prepareMath(text: string): string {
  const kept: string[] = [];
  return text
    .replace(LATEX_SPAN, (span) => `\u0000${kept.push(span) - 1}\u0000`)
    .replace(/(^|[^\\$\w])\$(\d[\d,]*(?:\.\d+)?)(?![\d$])/g, "$1\\$$$2")
    .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, "$$$$\n$1\n$$$$")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as never}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {prepareMath(text)}
      </ReactMarkdown>
    </div>
  );
}

/** A reply made by repeating a learned task: says so, and can hand the request to the AI instead. */
function LearnedMeta({ message }: { message: ChatMessage }) {
  const learned = message.learned!;
  const askAi = () => {
    const chat = useChats.getState().chats.find((c) => c.messages.some((m) => m.id === message.id));
    if (!chat) return;
    useVault.getState().forgetLearned(learned.taskId);
    void sendMessage(chat.id, learned.request, { speak: false, skipLearned: true });
  };
  return (
    <div className="msg-meta instant">
      <Icon name="spark" size={11} /> Learned · no AI
      <button className="link-btn learned-ask" onClick={askAi} title="Forget these saved steps and let the AI do this request (it learns it again if it works)">
        Ask AI instead
      </button>
    </div>
  );
}

/** /compact: earlier messages were folded into a summary; the summary can be opened. */
function CompactDivider({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="context-divider compact" role="separator">
      <button className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Earlier messages summarized — the AI now works from the summary · {open ? "Hide" : "Show"} summary
      </button>
      {open && <pre className="compact-summary">{message.content}</pre>}
    </div>
  );
}

export const MessageView = memo(function MessageView({ message }: { message: ChatMessage }) {
  if (message.divider === "compact") return <CompactDivider message={message} />;
  if (message.divider === "clear") {
    return (
      <div className="context-divider" role="separator">
        <span>Context cleared — earlier messages are no longer sent · SUMMARY.md reloads</span>
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
        {message.content && <div className="msg-bubble">{message.content}</div>}
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      {message.learned && <LearnedMeta message={message} />}
      {message.instant && !message.learned && (
        <div className="msg-meta instant">
          <Icon name="spark" size={11} /> Instant · no AI
        </div>
      )}
      {message.model && (
        <div className="msg-meta">
          <ProviderDot provider={message.model.provider} />
          {modelLabel(message.model)}
          {message.keyName && <span className="msg-key"> · {message.keyName}</span>}
          {message.usage && (
            <span
              className="msg-key"
              title={`${message.usage.input.toLocaleString()} tokens in (${message.usage.cached.toLocaleString()} from DeepSeek's cache, billed at a fraction) · ${message.usage.output.toLocaleString()} out · ${message.usage.steps} AI call${message.usage.steps === 1 ? "" : "s"}`}
            >
              {" "}
              · {shortCount(message.usage.input + message.usage.output)} tokens{message.usage.input ? ` · ${Math.round((message.usage.cached / message.usage.input) * 100)}% cached` : ""}
            </span>
          )}
        </div>
      )}
      {message.reasoning && (
        <details className="msg-thinking">
          <summary>{message.pending && !message.content ? "Thinking…" : "Thought it through"}</summary>
          <div className="msg-thinking-body">{message.reasoning}</div>
        </details>
      )}
      {message.blocks
        ? message.blocks.map((block, i) =>
            block.type === "text" ? (
              block.text.trim() ? <Markdown key={i} text={block.text} /> : null
            ) : (
              <ToolCard key={block.step.id} step={block.step} />
            ),
          )
        : message.content && <Markdown text={message.content} />}
      {message.checking && (
        <div className="fact-check checking" role="status">
          <span className="spinner small" /> Checking facts against sources…
        </div>
      )}
      {!message.pending && message.factCheck && (
        <div className={`fact-check ${message.factCheck}`}>
          <Icon name={message.factCheck === "unchecked" ? "alert" : "check"} size={11} />
          {message.factCheck === "verified"
            ? "Checked against sources"
            : message.factCheck === "corrected"
              ? "Corrected after checking sources"
              : "Couldn't double-check this answer"}
        </div>
      )}
      {message.pending && !message.checking && thinking(message) && (
        <div className="typing" aria-label="Generating">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.pending && message.content && <span className="caret" aria-hidden="true" />}
      {message.error && (
        <div className={`msg-error${message.error === "Stopped" ? " soft" : ""}`}>
          {message.error !== "Stopped" && <Icon name="alert" size={13} />}
          <span>{message.error}</span>
        </div>
      )}
    </div>
  );
});
