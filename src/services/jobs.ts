import { toolReadFile, workspaceApply, workspaceChanges, workspaceDiscard } from "../lib/ipc";
import { uid } from "../lib/ids";
import { lineDiff } from "../providers/agent/diff";
import { useChats } from "../store/chats";
import { useVault } from "../store/vault";
import type { Chat, KeyedProviderId, PlanView, ReviewFile, ReviewView } from "../types";

/** Plans, safe copies and the end-of-job review. */

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);

/** App names the user mentioned ("open Discord", "in Vivaldi"), so looking at them needs no approval. */
export function appsNamedIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:[Oo]pen|[Ii]n|[Oo]n|[Uu]sing|[Ww]ith|[Ll]aunch|[Ss]tart|[Ii]nto)\s+([A-Z][\w.&+-]*(?:\s[A-Z][\w.&+-]*)?)/g)) out.add(m[1]);
  return [...out];
}

/** Whether a plan changes project files or runs commands (and so gets a safe copy). */
export function hasWork(args: Record<string, unknown>): boolean {
  return list(args.files).length > 0 || list(args.commands).length > 0;
}

export function planFrom(args: Record<string, unknown>, safeCopy: boolean): PlanView {
  const steps = list(args.steps);
  return {
    title: String(args.title ?? "Plan").trim() || "Plan",
    steps,
    progress: steps.map(() => "todo"),
    files: list(args.files),
    commands: list(args.commands),
    apps: list(args.apps),
    access: list(args.access).map((a) => a.toLowerCase()),
    changeReason: typeof args.change_reason === "string" && args.change_reason.trim() ? args.change_reason.trim() : undefined,
    safeCopy,
  };
}

/** Points absolute paths into the real project at the safe copy instead. */
export function intoSafeCopy(args: Record<string, unknown>, workspace: NonNullable<Chat["workspace"]>): Record<string, unknown> {
  const project = workspace.project.replace(/\/$/, "");
  const swap = (v: unknown) =>
    typeof v === "string" && (v === project || v.startsWith(`${project}/`)) ? workspace.shadow + v.slice(project.length) : v;
  return { ...args, path: swap(args.path) };
}

/** Pictures cost tokens on every step; the model keeps only the latest few steps' pictures within a task. */
export function keepRecentPictures(_provider: KeyedProviderId, items: unknown[], keep = 2): unknown[] {
  let seen = 0;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i] as { role?: string; parts?: Record<string, unknown>[]; content?: unknown };
    // Gemini: inlineData parts. OpenAI-style: a user message whose content has image_url parts.
    const gemini = item?.parts?.some((p) => p.inlineData);
    const openAi = Array.isArray(item?.content) && (item.content as { type?: string }[]).some((p) => p?.type === "image_url");
    if (!gemini && !openAi) continue;
    seen++;
    if (seen <= keep) continue;
    out[i] = gemini
      ? { ...item, parts: item.parts!.map((p) => (p.inlineData ? { text: "[older picture removed]" } : p)) }
      : { ...item, content: (item.content as { type?: string }[]).map((p) => (p?.type === "image_url" ? { type: "text", text: "[older picture removed]" } : p)) };
  }
  return out;
}

const MAX_REVIEW_FILES = 40;

/** Adds the "review the changes" card for a job that ran in a safe copy. */
export async function addReview(chatId: string, messageId: string, workspace: NonNullable<Chat["workspace"]>): Promise<void> {
  const changes = await workspaceChanges(workspace.project, workspace.shadow).catch(() => []);
  if (!changes.length) {
    // Nothing changed: no review needed.
    await workspaceDiscard(workspace.shadow).catch(() => {});
    useChats.getState().setWorkspace(chatId, undefined);
    return;
  }
  const files: ReviewFile[] = [];
  for (const change of changes.slice(0, MAX_REVIEW_FILES)) {
    const read = async (base: string) => {
      const file = await toolReadFile(base, change.path).catch(() => null);
      return file?.exists ? file.content : "";
    };
    const before = change.status === "added" ? "" : await read(workspace.project);
    const after = change.status === "deleted" ? "" : await read(workspace.shadow);
    files.push({ path: change.path, status: change.status, ...lineDiff(before, after) });
  }
  const review: ReviewView = { title: workspace.title, project: workspace.project, shadow: workspace.shadow, files };
  useChats.getState().addBlock(chatId, messageId, {
    type: "tool",
    step: {
      id: uid("step-"),
      name: "review_changes",
      args: {},
      title: `Review: ${workspace.title}`,
      needsApproval: false,
      status: "done",
      review,
      result: `${changes.length} file${changes.length === 1 ? "" : "s"} changed${changes.length > MAX_REVIEW_FILES ? ` (first ${MAX_REVIEW_FILES} shown)` : ""}`,
    },
  });
}

function closeWorkspace(shadow: string): void {
  for (const chat of useChats.getState().chats) {
    if (chat.workspace?.shadow === shadow) useChats.getState().setWorkspace(chat.id, undefined);
  }
}

/** Keep: copy the job's changes into the real project. */
export async function keepReview(stepId: string, review: ReviewView): Promise<number> {
  const changes = await workspaceChanges(review.project, review.shadow);
  const applied = await workspaceApply(review.project, review.shadow, changes.map((c) => c.path));
  await workspaceDiscard(review.shadow).catch(() => {});
  closeWorkspace(review.shadow);
  useVault.getState().decline(stepId);
  useVault.getState().logActivity({ at: Date.now(), chat: "", tool: "review_changes", title: `Kept: ${review.title}`, outcome: "done", detail: `${applied} files` });
  return applied;
}

/** Throw away: delete the safe copy; the real project was never touched. */
export async function discardReview(stepId: string, review: ReviewView): Promise<void> {
  await workspaceDiscard(review.shadow).catch(() => {});
  closeWorkspace(review.shadow);
  useVault.getState().decline(stepId);
  useVault.getState().logActivity({ at: Date.now(), chat: "", tool: "review_changes", title: `Threw away: ${review.title}`, outcome: "done", detail: "" });
}
