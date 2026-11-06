import { memo, useState } from "react";
import { macRequestPermission, macSystem } from "../lib/ipc";
import { resolveApproval } from "../services/approvals";
import { answerQuestion } from "../services/questions";
import { discardReview, keepReview } from "../services/jobs";
import { usePreviews } from "../services/previews";
import { useNotice } from "../store/notice";
import { useVault } from "../store/vault";
import type { PlanStepStatus, ReviewFile, ToolPreview, ToolStep } from "../types";
import { GraphCard } from "./GraphCard";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<string, IconName> = {
  read_file: "file",
  write_file: "file",
  edit_file: "file",
  list_directory: "folder",
  find_files: "search",
  search_files: "search",
  run_command: "terminal",
  web_fetch: "download",
  web_search: "search",
  get_weather: "spark",
  sports: "spark",
  wikipedia: "search",
  convert_time: "history",
  calculate: "check",
  convert_units: "check",
  todo_write: "check",
  load_skill: "spark",
  mac_open: "download",
  mac_look: "search",
  mac_do: "check",
  mac_front: "search",
  browser_go: "download",
  browser_do: "check",
  browser_look: "search",
  browser_show: "spark",
  make_graph: "spark",
  mac_click: "check",
  mac_drag: "chevron",
  mac_menu: "chevron",
  mac_tabs: "search",
  mac_type: "file",
  mac_key: "terminal",
  mac_scroll: "chevron",
  mac_media: "spark",
  mac_system: "settings",
  mac_screen: "search",
  mac_applescript: "terminal",
  mac_shortcut: "spark",
  mac_quit: "close",
  mac_clipboard: "copy",
  propose_plan: "check",
  final_action: "alert",
  make_document: "file",
  command_output: "terminal",
  command_stop: "close",
  ask_user: "alert",
  agent: "spark",
};

const STATUS_LABEL: Record<ToolStep["status"], string> = {
  queued: "Queued",
  pending: "Waiting for approval",
  running: "Running…",
  done: "Done",
  denied: "Denied",
  error: "Failed",
};

function ScreenPreview({ imageId, caption }: { imageId: string; caption: string }) {
  const src = usePreviews((s) => s.images[imageId]);
  if (!src) return <div className="tool-preview tool-target"><span className="tool-target-label">Preview</span><code>{caption} (picture no longer kept)</code></div>;
  return (
    <figure className="tool-preview screen-preview">
      <img src={src} alt={caption} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function DiffLines({ lines, truncated }: { lines: ReviewFile["lines"]; truncated: boolean }) {
  return (
    <div className="tool-diff" role="table" aria-label="Changes">
      {lines.length === 0 && <div className="diff-line ctx">(no changes)</div>}
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`} role="row">
          <span className="diff-no">{line.kind === "gap" ? "" : line.line}</span>
          <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "gap" ? "⋯" : " "}</span>
          <span className="diff-text">{line.kind === "gap" ? "" : line.text || " "}</span>
        </div>
      ))}
      {truncated && <div className="diff-line gap">… more changes not shown</div>}
    </div>
  );
}

function Preview({ preview }: { preview: ToolPreview }) {
  if (preview.kind === "screen") return <ScreenPreview imageId={preview.imageId} caption={preview.caption} />;
  if (preview.kind === "command") {
    return (
      <div className="tool-preview">
        <pre className="tool-command">
          <span className="tool-prompt">$</span> {preview.command}
        </pre>
        <div className="tool-cwd">in {preview.cwd}</div>
      </div>
    );
  }
  if (preview.kind === "target") {
    return (
      <div className="tool-preview tool-target">
        <span className="tool-target-label">{preview.label}</span>
        <code>{preview.value}</code>
      </div>
    );
  }
  const added = preview.lines.filter((l) => l.kind === "add").length;
  const removed = preview.lines.filter((l) => l.kind === "del").length;
  return (
    <div className="tool-preview">
      <div className="tool-diff-head">
        <code>{preview.path}</code>
        <span className="tool-diff-stats">
          {preview.isNew ? "new file · " : ""}
          <span className="add">+{added}</span> <span className="del">−{removed}</span>
        </span>
      </div>
      <DiffLines lines={preview.lines} truncated={preview.truncated} />
    </div>
  );
}

const PLAN_MARK: Record<PlanStepStatus, string> = { todo: "○", doing: "◐", done: "✓", skipped: "–" };

/** A job plan: the checklist, what it may touch, and live progress once approved. */
function PlanCard({ step, buttons }: { step: ToolStep; buttons: React.ReactNode }) {
  const plan = step.plan!;
  const scope = [
    ...plan.files.map((f) => `file ${f}`),
    ...plan.commands.map((c) => `$ ${c}`),
    ...plan.apps.map((a) => `app ${a}`),
    ...plan.access.map((a) => (a === "screen" ? "whole screen" : a === "clipboard" ? "read clipboard" : a)),
  ];
  return (
    <div className={`tool-card plan-card status-${step.status}`}>
      <div className="tool-head">
        <Icon name="check" size={13} />
        <span className="tool-title">{plan.changeReason ? "Change of plan: " : "Plan: "}{plan.title}</span>
        {step.approvedByVoice && step.status !== "pending" && <span className="tool-voice">Approved by voice</span>}
        <span className={`tool-status status-${step.status}`}>{step.status === "done" ? "Approved" : STATUS_LABEL[step.status]}</span>
      </div>
      {plan.changeReason && <div className="plan-reason">{plan.changeReason}</div>}
      <ol className="plan-steps">
        {plan.steps.map((text, i) => (
          <li key={i} className={`plan-step ${plan.progress[i] ?? "todo"}`}>
            <span className="plan-mark" aria-hidden="true">{PLAN_MARK[plan.progress[i] ?? "todo"]}</span>
            {text}
          </li>
        ))}
      </ol>
      {scope.length > 0 && (
        <div className="plan-scope">
          <span>Allowed without asking again:</span>
          {scope.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      )}
      {plan.safeCopy && <div className="plan-note">Runs in a safe copy of your project — nothing changes for real until you review and keep it.</div>}
      {buttons}
    </div>
  );
}

/** What a job changed in its safe copy: review it, then Keep or Throw away. */
function ReviewCard({ step }: { step: ToolStep }) {
  const review = step.review!;
  const handled = useVault((s) => s.declined.includes(step.id));
  const [open, setOpen] = useState<string | null>(review.files[0]?.path ?? null);
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    setBusy(true);
    try {
      const count = await keepReview(step.id, review);
      useNotice.getState().show({ message: `Kept ${count} change${count === 1 ? "" : "s"} in ${review.project.split("/").pop()}.` });
    } catch (err) {
      useNotice.getState().show({ message: `Couldn't keep the changes: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`tool-card review-card${handled ? " handled" : ""}`}>
      <div className="tool-head">
        <Icon name="file" size={13} />
        <span className="tool-title">{step.title}</span>
        <span className="tool-status">{handled ? "Decided" : step.result}</span>
      </div>
      <ul className="review-files">
        {review.files.map((f) => (
          <li key={f.path}>
            <button className={`review-file ${f.status}`} onClick={() => setOpen(open === f.path ? null : f.path)} aria-expanded={open === f.path}>
              <span className="review-status">{f.status}</span>
              <code>{f.path}</code>
              <span className="tool-diff-stats">
                <span className="add">+{f.lines.filter((l) => l.kind === "add").length}</span> <span className="del">−{f.lines.filter((l) => l.kind === "del").length}</span>
              </span>
            </button>
            {open === f.path && <DiffLines lines={f.lines} truncated={f.truncated} />}
          </li>
        ))}
      </ul>
      {!handled && (
        <div className="tool-actions">
          <span className="tool-ask">Your real project hasn't changed yet.</span>
          <button className="btn small deny" disabled={busy} onClick={() => void discardReview(step.id, review)}>
            Throw away
          </button>
          <button className="btn small approve" disabled={busy} onClick={() => void keep()}>
            <Icon name="check" size={12} /> Keep changes
          </button>
        </div>
      )}
    </div>
  );
}

function PermissionHelp({ result }: { result: string }) {
  const kind = /^PERMISSION:(\w+)/.exec(result)?.[1] as "accessibility" | "screen" | undefined;
  if (!kind) return null;
  return (
    <div className="tool-warning permission">
      <Icon name="alert" size={12} /> macOS needs to allow E.V to {kind === "screen" ? "see app windows (Screen Recording)" : "read and control apps (Accessibility)"}.
      <button className="btn small" onClick={() => void macRequestPermission(kind)}>
        Grant access
      </button>
    </div>
  );
}

/** Teaching and schedule actions: a one-line receipt with Undo (and Yes / No for suggestions). */
function MemoryReceipt({ step }: { step: ToolStep }) {
  const vault = useVault();
  const undo = step.undo;
  // Refused suggestions and refused schedule changes leave no receipt.
  if ((step.name === "suggest_memory" || step.name.startsWith("schedule_")) && step.status !== "done") return null;
  if (!undo || step.status !== "done") {
    return (
      <div className="tool-card auto memory-receipt">
        <div className="tool-head">
          <Icon name="spark" size={12} />
          <span className="tool-title">{step.status === "error" ? `${step.title}: ${step.result ?? "not saved"}` : `${step.title} ${step.result ? `· ${step.result}` : ""}`}</span>
        </div>
      </div>
    );
  }
  const handled = vault.declined.includes(step.id);
  const done = () => vault.decline(step.id);
  let label = step.title;
  let text = step.result ?? "";
  let actions: React.ReactNode = null;

  switch (undo.type) {
    case "memory": {
      const item = vault.memories.find((m) => m.id === undo.id);
      label = undo.before ? "Updated memory" : "Learned";
      if (!handled && item) {
        const other = item.scope === "gideon" ? "chat" : "gideon";
        actions = (
          <>
            <span className="memory-scope">{item.scope === "gideon" ? "E.V memory" : "This chat"}</span>
            {(other === "gideon" || item.chatId) && (
              <button className="link-btn" onClick={() => vault.updateMemory(item.id, { scope: other })}>
                {other === "gideon" ? "Use everywhere" : "Only this chat"}
              </button>
            )}
            <button
              className="link-btn"
              onClick={() => {
                if (undo.before) vault.restore(undo.before);
                else vault.forget(undo.id);
                done();
              }}
            >
              Undo
            </button>
          </>
        );
      }
      if (handled) label = "Undone";
      break;
    }
    case "forgot":
      label = handled ? "Restored" : "Forgot";
      text = undo.item.text;
      if (!handled)
        actions = (
          <button className="link-btn" onClick={() => (vault.restore(undo.item), done())}>
            Undo
          </button>
        );
      break;
    case "suggestion": {
      const saved = vault.memories.some((m) => m.sourceStepId === step.id);
      label = saved ? "Saved to E.V memory" : handled ? "Not saved" : "Remember this?";
      text = undo.text;
      if (!saved && !handled)
        actions = (
          <>
            <button className="btn small approve" onClick={() => vault.remember({ text: undo.text, kind: undo.kind, scope: "gideon", sourceStepId: step.id })}>
              Yes
            </button>
            <button className="btn small ghost" onClick={done}>
              No
            </button>
          </>
        );
      break;
    }
    case "system":
      label = handled ? "Settings restored" : "Mac settings changed";
      text = [
        undo.before.volume !== undefined && "volume",
        undo.before.muted !== undefined && "mute",
        undo.before.darkMode !== undefined && "dark mode",
      ]
        .filter(Boolean)
        .join(", ");
      if (!handled)
        actions = (
          <button
            className="link-btn"
            onClick={() => {
              void macSystem({
                volume: undo.before.volume ?? undefined,
                muted: undo.before.muted ?? undefined,
                darkMode: undo.before.darkMode ?? undefined,
              });
              done();
            }}
          >
            Undo all
          </button>
        );
      break;
    case "event-added":
      label = handled ? "Schedule undone" : "Scheduled";
      if (!handled)
        actions = (
          <button className="link-btn" onClick={() => (vault.removeEvent(undo.id), done())}>
            Undo
          </button>
        );
      break;
    case "event-changed":
    case "event-removed": {
      const before = undo.type === "event-changed" ? undo.before : undo.item;
      label = handled ? "Schedule restored" : undo.type === "event-changed" ? "Schedule changed" : "Removed from schedule";
      if (!handled)
        actions = (
          <button className="link-btn" onClick={() => (vault.restoreEvent(before), done())}>
            Undo
          </button>
        );
      break;
    }
  }
  return (
    <div className={`memory-receipt${undo.type === "suggestion" ? " suggestion" : ""}${handled ? " handled" : ""}`}>
      <Icon name={undo.type.startsWith("event") ? "history" : "spark"} size={12} />
      <span className="memory-label">{label}</span>
      <span className="memory-text">{text}</span>
      <span className="memory-actions">{actions}</span>
    </div>
  );
}

/** ask_user: the AI's question with clickable choices; the user can also type an answer or skip. */
function QuestionCard({ step }: { step: ToolStep }) {
  const q = step.question!;
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const open = step.status === "pending";
  const send = (answer: string[] | null) => answerQuestion(step.id, answer);
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  // Keys while the question waits: 1–4 picks a choice (toggles in multi-select), Esc skips.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || (e.target as HTMLElement).tagName === "INPUT") return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      const label = q.options[n - 1].label;
      if (q.multi) toggle(label);
      else send([label]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      send(null);
    }
  };
  return (
    <div className={`tool-card question-card status-${step.status}`} onKeyDown={onKeyDown}>
      <div className="tool-head">
        <Icon name="alert" size={13} />
        <span className="tool-title">{q.question}</span>
        {!open && <span className={`tool-status status-${step.status}`}>{step.status === "done" ? "Answered" : step.status === "denied" ? "Skipped" : STATUS_LABEL[step.status]}</span>}
      </div>
      {open ? (
        <>
          <div className="question-options" role={q.multi ? "group" : "radiogroup"} aria-label={q.question}>
            {q.options.map((o, i) => {
              const chosen = picked.includes(o.label);
              return (
                <button
                  key={o.label}
                  autoFocus={i === 0}
                  title={`Press ${i + 1}`}
                  className={`question-option${chosen ? " chosen" : ""}`}
                  role={q.multi ? "checkbox" : "radio"}
                  aria-checked={chosen}
                  onClick={() => (q.multi ? toggle(o.label) : send([o.label]))}
                >
                  <span className="question-label">
                    <kbd className="question-key">{i + 1}</kbd> {o.label}
                  </span>
                  {o.description && <span className="question-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <form
            className="question-other"
            onSubmit={(e) => {
              e.preventDefault();
              const typed = other.trim();
              if (typed) send([...picked, typed]);
              else if (picked.length) send(picked);
            }}
          >
            <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Or type your own answer…" aria-label="Your own answer" />
            {(q.multi || other.trim()) && (
              <button type="submit" className="btn small approve" disabled={!other.trim() && picked.length === 0}>
                <Icon name="check" size={12} /> Send
              </button>
            )}
            <button type="button" className="btn small ghost" onClick={() => send(null)}>
              Skip
            </button>
          </form>
        </>
      ) : (
        q.answer && <div className="question-answer">{q.answer.join(" · ")}</div>
      )}
    </div>
  );
}

/** Past-tense line for an action that ran without asking, e.g. "Searched the web for …". */
function autoTitle(step: ToolStep): string {
  const title = step.title;
  const verbs: [RegExp, string][] = [
    [/^Search the web for/, "Searched the web for"],
    [/^Open web page/, "Opened web page"],
    [/^Read /, "Read "],
    [/^List folder/, "Listed folder"],
    [/^Find /, "Found "],
    [/^Search file contents/, "Searched file contents"],
    [/^Run command/, "Ran"],
    [/^Check weather/, "Checked weather"],
    [/^Check /, "Checked "],
    [/^Look up/, "Looked up"],
    [/^Convert /, "Converted "],
    [/^Calculate /, "Calculated "],
  ];
  if (step.status !== "done") return title;
  for (const [pattern, past] of verbs) if (pattern.test(title)) return title.replace(pattern, past);
  return title;
}

/**
 * One action the AI asked for. Pending cards block the AI until the user approves or denies;
 * actions approved together share one decision, shown on the last card of the group.
 */
export const ToolCard = memo(function ToolCard({ step }: { step: ToolStep }) {
  const [showResult, setShowResult] = useState(false);
  const pending = step.status === "pending";
  const internal = !step.needsApproval && !step.auto;
  const decisionId = step.approvalId ?? step.id;
  const group = step.groupSize ?? 1;
  const showButtons = pending && (group === 1 || step.groupLast);

  // Progress shows as ticks on the plan card itself.
  if (step.name === "plan_progress") return null;
  if (step.review) return <ReviewCard step={step} />;

  const finalAction = step.final || step.name === "final_action";
  const approveLabel = step.plan ? "Approve plan" : finalAction ? (step.title.startsWith("Delete") ? "Delete now" : "Send now") : group > 1 ? `Approve all ${group} now` : "Approve now";
  const buttons = showButtons ? (
    <div className={`tool-actions${finalAction ? " final" : ""}`}>
      <span className="tool-ask">
        {step.plan ? "Approve this plan? Steps inside it won't ask again." : finalAction ? "This can't be taken back." : group > 1 ? `Allow all ${group} changes?` : "Allow this?"}
      </span>
      <button className="btn small deny" onClick={() => resolveApproval(decisionId, false)}>
        {finalAction ? "Don't" : group > 1 ? "Deny all" : "Deny"}
      </button>
      {step.always && (
        <button className="btn small approve-always" title={`From now on: ${step.always.label}`} onClick={() => resolveApproval(decisionId, true, false, true)}>
          Approve always
        </button>
      )}
      <button className="btn small approve" onClick={() => resolveApproval(decisionId, true)}>
        <Icon name="check" size={12} /> {approveLabel}
      </button>
    </div>
  ) : null;

  if (step.plan) return <PlanCard step={step} buttons={buttons} />;

  if (step.undo || ["remember", "forget", "suggest_memory", "schedule_add", "schedule_update", "schedule_delete"].includes(step.name)) {
    return <MemoryReceipt step={step} />;
  }

  if (step.question) return <QuestionCard step={step} />;
  if (step.graph) return <GraphCard step={step} />;
  if (step.helpers) return <HelpersCard step={step} />;

  if (step.auto) {
    const command = step.name === "run_command" ? ` ${String(step.args.command ?? "")}` : "";
    return (
      <div className={`tool-card auto status-${step.status}`}>
        <div className="tool-head">
          <Icon name={ICONS[step.name] ?? "spark"} size={12} />
          <span className="tool-title">
            {autoTitle(step)}
            {command && <code>{command}</code>}
          </span>
          {step.alwaysApproved && <span className="tool-voice">Always approved</span>}
          {step.status !== "done" && <span className={`tool-status status-${step.status}`}>{STATUS_LABEL[step.status]}</span>}
          {step.result && !step.result.startsWith("PERMISSION:") && (step.status === "done" || step.status === "error") && (
            <button className="tool-result-toggle inline" onClick={() => setShowResult((s) => !s)} aria-expanded={showResult} title={showResult ? "Hide what it returned" : "Show what it returned"}>
              <Icon name={showResult ? "chevronUp" : "chevron"} size={11} />
            </button>
          )}
        </div>
        {showResult && step.result && <pre className="tool-result">{step.result}</pre>}
        {step.result && <PermissionHelp result={step.result} />}
      </div>
    );
  }

  return (
    <div className={`tool-card status-${step.status}${internal ? " quiet" : ""}${step.outside ? " outside" : ""}${finalAction ? " final" : ""}${pending && group > 1 ? " grouped" : ""}`}>
      <div className="tool-head">
        <Icon name={ICONS[step.name] ?? "spark"} size={13} />
        <span className="tool-title">{step.title}</span>
        {step.alwaysApproved && <span className="tool-voice">Always approved</span>}
        {step.approvedByVoice && !step.alwaysApproved && step.status !== "pending" && <span className="tool-voice">Approved by voice</span>}
        <span className={`tool-status status-${step.status}`}>{STATUS_LABEL[step.status]}</span>
      </div>
      {step.outside && (
        <div className="tool-warning">
          <Icon name="alert" size={12} /> Outside the project folder
        </div>
      )}
      {step.outsidePlan && (
        <div className="tool-warning">
          <Icon name="alert" size={12} /> Outside the plan you approved
        </div>
      )}
      {finalAction && step.status === "pending" && (
        <div className="tool-warning">
          <Icon name="alert" size={12} /> Final step — check the preview before approving
        </div>
      )}
      {step.preview && (pending || step.status === "denied" || step.preview.kind !== "target") && !internal && <Preview preview={step.preview} />}
      {buttons}
      {step.result && <PermissionHelp result={step.result} />}
      {step.result && !step.result.startsWith("PERMISSION:") && (step.status === "done" || step.status === "error") && (
        internal ? (
          <pre className="tool-result">{step.result}</pre>
        ) : (
          <>
            <button className="tool-result-toggle" onClick={() => setShowResult((s) => !s)}>
              <Icon name={showResult ? "chevronUp" : "chevron"} size={11} /> {showResult ? "Hide output" : "Show output"}
            </button>
            {showResult && <pre className="tool-result">{step.result}</pre>}
          </>
        )
      )}
    </div>
  );
});

/** split_into_helpers: the main AI and its helpers working at the same time, each with what it's doing. */
function HelpersCard({ step }: { step: ToolStep }) {
  const helpers = step.helpers ?? [];
  const running = step.status === "running";
  const busy = helpers.filter((h) => h.status === "working").length;
  const agent = step.name === "agent" || step.name === "condense_document";
  const condensing = step.name === "condense_document";
  return (
    <div className={`tool-card helpers-card status-${step.status}`}>
      <div className="helpers-top">
        <div className="helpers-team" aria-hidden="true">
          <span className={`team-ai main${running ? " live" : ""}`}>
            <b>M</b>
          </span>
          {helpers.map((h, i) => (
            <span key={i} className={`team-ai helper-${h.status}${h.status === "working" ? " live" : ""}`}>
              <b>{String.fromCharCode(65 + i)}</b>
            </span>
          ))}
        </div>
        <div className="helpers-headline">
          <span className="helpers-count">
            <span className="tool-title">{step.title}</span>
            {condensing ? " · page groups in parallel" : agent ? " · sub-agent" : ` · ${helpers.length + 1} AIs`}
          </span>
          <span className="helpers-state">
            {running ? (condensing ? "Condensing a few pages at a time…" : agent ? "Working on its own…" : `${busy} helper${busy === 1 ? "" : "s"} working at the same time…`) : step.result || "Done"}
          </span>
        </div>
        <span className="tool-model">{agent ? `on ${step.helpersModel ?? "this chat's model"}` : "helpers on 3.5 Flash-Lite"}</span>
      </div>
      <ol className="helpers-list">
        {helpers.map((h, i) => (
          <li key={i} className={`helper helper-${h.status}`}>
            <span className="helper-letter">{String.fromCharCode(65 + i)}</span>
            <span className="helper-title">{h.title}</span>
            <span className="helper-note">{h.note}</span>
            <span className="helper-state">{h.status === "working" ? <span className="spinner small" /> : h.status === "done" ? "✓" : "✗"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
