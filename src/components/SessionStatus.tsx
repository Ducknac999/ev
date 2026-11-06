import { chatStatus } from "../lib/chatStatus";
import { modelLabel } from "../providers/catalog";
import { useTerminals, type TerminalRuntime } from "../services/terminals";
import type { Chat } from "../types";
import { Icon } from "./Icon";
import { ProviderDot } from "./ModelPicker";

export type SessionState = "ready" | "streaming" | "running" | "attention" | "exited" | "error" | "paused" | "locked";

export function terminalState(runtime: TerminalRuntime | undefined): { kind: SessionState; label: string } {
  if (!runtime) return { kind: "ready", label: "Starting" };
  if (runtime.error) return { kind: "error", label: "Failed" };
  if (runtime.attention) return { kind: "attention", label: "Needs you" };
  if (runtime.notStarted) return { kind: "ready", label: "Not run" };
  if (!runtime.running) return { kind: "exited", label: runtime.exitCode === 0 ? "Exited" : `Exit ${runtime.exitCode ?? "?"}` };
  if (runtime.unread) return { kind: "streaming", label: "Output" };
  return { kind: "running", label: "Running" };
}

export function useSessionState(chat: Chat): { kind: SessionState; label: string } {
  const runtime = useTerminals((s) => s.byId[chat.id]);
  if (chat.kind === "browser") return { kind: "ready", label: "Browser" };
  if (chat.kind !== "ai") return terminalState(runtime);
  return chatStatus(chat);
}

/** Status pill for any session kind. */
export function SessionStatusPill({ chat }: { chat: Chat }) {
  const { kind, label } = useSessionState(chat);
  return (
    <span className={`status-pill status-${kind}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

const KIND_NAMES = { claude: "Claude Code", codex: "Codex", shell: "Terminal", command: "Command", browser: "E.V Browser" } as const;

/** "Gemini 3.5 Flash", "Claude Code", "Terminal"… */
export function sessionLabel(chat: Chat): string {
  return chat.kind === "ai" ? modelLabel(chat.model) : KIND_NAMES[chat.kind];
}

/** Small leading glyph: provider dot for AI chats, an icon for terminals. */
export function SessionGlyph({ chat }: { chat: Chat }) {
  if (chat.kind === "ai") return <ProviderDot provider={chat.model.provider} />;
  return <Icon name={chat.kind === "claude" ? "spark" : chat.kind === "browser" ? "globe" : "terminal"} size={11} className={`glyph-${chat.kind}`} />;
}
