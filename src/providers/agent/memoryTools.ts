import { passphraseCheck } from "../../lib/ipc";
import { describeEvent, readBack, syncToCalendar, upcoming } from "../../services/schedule";
import { announceImportant, confirmQuietly } from "../../services/announce";
import { useSettings } from "../../store/settings";
import { useVault } from "../../store/vault";
import type { MemoryItem, MemoryKind, Repeat, ScheduleItem, UndoInfo } from "../../types";
import { parseInstant, userTimeZone } from "./liveTools";
import type { ToolDefinition } from "./tools";

/** Teaching (memory) and schedule tools. They only touch E.V's own encrypted store. */

const KINDS: MemoryKind[] = ["about", "preference", "rule", "lesson", "word", "note"];
const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"];

export const MEMORY_TOOLS = new Set(["remember", "forget", "suggest_memory", "schedule_add", "schedule_update", "schedule_delete", "schedule_list"]);

export const MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "remember",
    description:
      "Save something the user taught you. Use when they ask you to remember, state a lasting fact about themselves, give a preference or rule, show an example of how they want answers, define their own words, praise a way of answering, or correct you (save the general lesson). Pass replaces=<id> to update an existing memory instead of adding a duplicate.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Short, self-contained, third person, e.g. 'Lives in Springfield, California (Pacific time)'" },
        kind: { type: "string", description: "about · preference · rule · lesson · word · note", enum: KINDS },
        scope: { type: "string", description: "'gideon' = every AI and chat (things about the user); 'chat' = only this chat's topic", enum: ["gideon", "chat"] },
        replaces: { type: "string", description: "Id of the memory this updates (e.g. after 'I moved to…')" },
      },
      required: ["text", "kind", "scope"],
    },
  },
  {
    name: "forget",
    description: "Delete a memory when the user asks you to forget it.",
    parameters: { type: "object", properties: { id: { type: "string", description: "Memory id" } }, required: ["id"] },
  },
  {
    name: "suggest_memory",
    description:
      "Offer to remember a lasting personal fact the user mentioned in passing without asking you to remember it. The user sees 'Remember this? Yes / No'. Never for schedules or plans; never for secrets.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What would be saved" },
        kind: { type: "string", description: "Memory kind", enum: KINDS },
      },
      required: ["text", "kind"],
    },
  },
  {
    name: "schedule_add",
    description:
      "Add an event to the user's schedule. ONLY when the user explicitly asks to add/schedule/remind — never because they mention a plan. Times are the user's local time unless they name a zone.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "e.g. 'Gym'" },
        start: { type: "string", description: "Local date and time, 'YYYY-MM-DD HH:MM' (24-hour)" },
        repeat: { type: "string", description: "How it repeats", enum: REPEATS },
        until: { type: "string", description: "Last date for a repeating event, YYYY-MM-DD (optional)" },
        notes: { type: "string", description: "Optional details" },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "schedule_update",
    description: "Change an event the user asked to change (move, rename, change repeat).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Event id" },
        title: { type: "string", description: "New title" },
        start: { type: "string", description: "New local start, 'YYYY-MM-DD HH:MM'" },
        repeat: { type: "string", description: "New repeat", enum: REPEATS },
        until: { type: "string", description: "New last date, YYYY-MM-DD" },
        notes: { type: "string", description: "New notes" },
      },
      required: ["id"],
    },
  },
  {
    name: "schedule_delete",
    description: "Delete an event the user asked to cancel or remove.",
    parameters: { type: "object", properties: { id: { type: "string", description: "Event id" } }, required: ["id"] },
  },
  {
    name: "schedule_list",
    description: "List the user's events between two dates (defaults: today through the next 14 days).",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
    },
  },
];

const SECRET_PATTERNS = [
  /\b(password|passwd|passcode|pin|api[\s_-]?key|secret|token|passphrase)\b\s*(is|:|=)/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
];

/** Passwords, keys, card numbers and the approval passphrase are never stored. */
export async function looksSecret(text: string): Promise<boolean> {
  if (SECRET_PATTERNS.some((p) => p.test(text))) return true;
  return passphraseCheck(text).catch(() => false);
}

/** Plans and appointments: never offered as memories (schedules are only added when asked). */
export function looksLikePlan(text: string): boolean {
  return (
    /\b(appointment|meeting|reservation|interview|flight|class|practice|session|deadline|due|party|dinner|lunch|gym|dentist|doctor|game|match|haircut|call)\b/i.test(text) &&
    /\b(\d{1,2}(:\d{2})?\s*(am|pm)?|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|next week|this week|weekend)\b/i.test(text)
  );
}

const REFUSE_SECRET =
  "Not saved: this looks like a password, key, code or card number, and E.V never stores those. Tell the user that briefly.";

export interface MemoryContext {
  chatId: string;
  chatTitle: string;
  stepId: string;
  /** The request was spoken (Hey E.V, hold to talk): a reminder is read back out loud. */
  heardByVoice?: boolean;
  /** What the user said this turn; schedule changes need an explicit request in it. */
  userText?: string;
}

const ASKS: Record<string, RegExp> = {
  schedule_add: /\b(add|schedule|put|book|set( up)?|create|make|remind me|reminder|calendar|plan)\b/i,
  schedule_update: /\b(move|change|reschedule|push|update|shift|rename|edit|make it|instead)\b/i,
  schedule_delete: /\b(cancel|delete|remove|clear|drop|take off|get rid of)\b/i,
};

/** Schedules change only when the user's own words ask for it — never because a plan was mentioned. */
export function userAskedFor(tool: string, userText: string | undefined): boolean {
  const pattern = ASKS[tool];
  return !pattern || (userText !== undefined && pattern.test(userText));
}

const NOT_ASKED =
  "Not done: the user didn't ask to change their schedule — they only mentioned a plan. Don't add it, don't ask whether to, and don't say you noted or saved it; just reply naturally.";

export interface MemoryOutcome {
  output: string;
  display: string;
  ok: boolean;
  undo?: UndoInfo;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));

function checkStart(start: string, zone: string): number {
  return parseInstant(start, zone);
}

export async function executeMemoryTool(name: string, args: Record<string, unknown>, ctx: MemoryContext): Promise<MemoryOutcome> {
  const vault = useVault.getState();
  if (!vault.loaded) {
    return { output: `E.V memory is unavailable right now (${vault.error ?? "still loading"}). Tell the user it wasn't saved.`, display: "Memory unavailable", ok: false };
  }
  switch (name) {
    case "remember": {
      const text = str(args.text);
      if (!text) return { output: "Nothing to remember.", display: "Nothing saved", ok: false };
      if (await looksSecret(text)) return { output: REFUSE_SECRET, display: "Not saved — looks like a secret", ok: false };
      const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : "note";
      const scope = args.scope === "chat" ? "chat" : "gideon";
      const replaces = str(args.replaces) || undefined;
      const { item, replaced } = vault.remember(
        { text, kind, scope, chatId: ctx.chatId, chatTitle: ctx.chatTitle, sourceStepId: ctx.stepId },
        replaces && vault.memories.some((m) => m.id === replaces) ? replaces : undefined,
      );
      return {
        output: `${replaced ? "Updated" : "Saved"} memory ${item.id} (${scope === "gideon" ? "E.V memory, every AI" : "this chat only"}). Confirm to the user in one short sentence what you learned.`,
        display: text,
        ok: true,
        undo: { type: "memory", id: item.id, before: replaced },
      };
    }
    case "forget": {
      const gone = vault.forget(str(args.id));
      if (!gone) return { output: `No memory with id ${str(args.id)}.`, display: "Nothing to forget", ok: false };
      return { output: `Forgot: ${gone.text}`, display: gone.text, ok: true, undo: { type: "forgot", item: gone } };
    }
    case "suggest_memory": {
      const text = str(args.text);
      if (looksLikePlan(text)) {
        return { output: "Not suggested: plans and appointments are never saved or offered unless the user explicitly asks to add them. Don't ask about adding it; just reply naturally.", display: "", ok: false };
      }
      if (!text || (await looksSecret(text))) return { output: "Not suggested.", display: "", ok: false };
      const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : "about";
      return {
        output: "The user now sees 'Remember this? Yes / No'. Don't ask again in text; continue normally.",
        display: text,
        ok: true,
        undo: { type: "suggestion", text, kind },
      };
    }
    case "schedule_add": {
      if (!userAskedFor(name, ctx.userText)) return { output: NOT_ASKED, display: "", ok: false };
      const zone = userTimeZone();
      const start = str(args.start);
      const at = checkStart(start, zone);
      const repeat = REPEATS.includes(args.repeat as Repeat) ? (args.repeat as Repeat) : "none";
      const event = vault.addEvent({ title: str(args.title) || "Event", start, timeZone: zone, repeat, until: str(args.until) || undefined, notes: str(args.notes) || undefined });
      const past = at < Date.now() && repeat === "none" ? " Note: that time is already in the past — tell the user." : "";
      // In the Mac's Calendar too (it rings even when E.V is closed), and said back so a misheard day or time is caught.
      syncToCalendar("upsert", event);
      // Asked by voice: read back out loud, so a misheard day or time is caught. Typed: chime + notch.
      const confirm = ctx.heardByVoice ? announceImportant : confirmQuietly;
      void confirm(`Reminder set. ${readBack(event)}`);
      return { output: `Added ${event.id}: ${describeEvent(event)}.${past} It's in Calendar too, and E.V ${ctx.heardByVoice ? "read it back to the user out loud" : "showed it in the notch"}.`, display: describeEvent(event), ok: true, undo: { type: "event-added", id: event.id } };
    }
    case "schedule_update": {
      if (!userAskedFor(name, ctx.userText)) return { output: NOT_ASKED, display: "", ok: false };
      const id = str(args.id);
      const before = vault.schedule.find((e) => e.id === id);
      if (!before) return { output: `No event with id ${id}.`, display: "Event not found", ok: false };
      const patch: Partial<ScheduleItem> = {};
      if (str(args.title)) patch.title = str(args.title);
      if (str(args.start)) {
        checkStart(str(args.start), before.timeZone);
        patch.start = str(args.start);
      }
      if (REPEATS.includes(args.repeat as Repeat)) patch.repeat = args.repeat as Repeat;
      if (args.until !== undefined) patch.until = str(args.until) || undefined;
      if (args.notes !== undefined) patch.notes = str(args.notes) || undefined;
      const after = vault.updateEvent(id, patch)!;
      syncToCalendar("upsert", after);
      void (ctx.heardByVoice ? announceImportant : confirmQuietly)(`Reminder changed. ${readBack(after)}`);
      return { output: `Updated ${id}: ${describeEvent(after)}.`, display: describeEvent(after), ok: true, undo: { type: "event-changed", before } };
    }
    case "schedule_delete": {
      if (!userAskedFor(name, ctx.userText)) return { output: NOT_ASKED, display: "", ok: false };
      const gone = vault.removeEvent(str(args.id));
      if (!gone) return { output: `No event with id ${str(args.id)}.`, display: "Event not found", ok: false };
      syncToCalendar("delete", gone);
      return { output: `Deleted: ${describeEvent(gone)}.`, display: describeEvent(gone), ok: true, undo: { type: "event-removed", item: gone } };
    }
    case "schedule_list": {
      const zone = userTimeZone();
      const from = str(args.from) ? parseInstant(`${str(args.from)} 00:00`, zone) : Date.now() - 3_600_000;
      const to = str(args.to) ? parseInstant(`${str(args.to)} 23:59`, zone) : from + 14 * 86_400_000;
      const list = upcoming(vault.schedule, from, to);
      const text = list.length ? list.map((o) => `- [${o.event.id}] ${describeEvent(o.event, o.at)}`).join("\n") : "No events in that period.";
      return { output: text, display: `${list.length} event${list.length === 1 ? "" : "s"}`, ok: true };
    }
    default:
      return { output: `Unknown tool ${name}.`, display: "", ok: false };
  }
}

/** Memory and schedule context added to every agent's system prompt. */
export function memoryPrompt(chatId: string, now = Date.now()): string {
  const { memories, schedule, loaded } = useVault.getState();
  if (!loaded) return "# Memory\nE.V memory couldn't be opened right now; don't claim to remember or save anything.";
  const line = (m: MemoryItem) => `- [${m.id}] (${m.kind}) ${m.text}`;
  const gideon = memories.filter((m) => m.scope === "gideon");
  const chat = memories.filter((m) => m.scope === "chat" && m.chatId === chatId);
  const soon = upcoming(schedule, now - 3_600_000, now + 7 * 86_400_000);
  const lead = useSettings.getState().settings.reminders.leadMinutes;
  return [
    "# Memory — what the user has taught you",
    "The user teaches you the way they'd train a person. Use everything below in every answer; it overrides your defaults.",
    "- Save with remember when they ask you to remember, state a lasting fact about themselves, set a preference or rule (\"from now on…\", \"always…\", \"never…\"), show an example of how they want answers, define their own words, praise a way of answering, or correct you. A correction becomes a lesson: save the general rule, not just the one fact.",
    "- Short, self-contained, third person: \"Lives in Springfield, California (Pacific time)\". If it changes an existing memory (moved, new preference), pass replaces with its id — never keep two conflicting memories.",
    "- scope gideon: about the user or how every AI should behave. scope chat: only this conversation's topic or project, or when they say \"just for this chat\".",
    "- \"Forget …\" → forget. \"What do you know about me?\" → list the memories in plain words. After saving, confirm in one short sentence, in your own words, what you learned.",
    "- A lasting personal fact mentioned in passing (not asked to remember) → suggest_memory once. Never for plans or schedules.",
    "- Never store passwords, keys, codes, card numbers or the approval passphrase, even if asked — say so kindly.",
    "",
    "## E.V memory (every AI, every chat)",
    gideon.length ? gideon.map(line).join("\n") : "(nothing yet)",
    "",
    "## This chat's memory",
    chat.length ? chat.map(line).join("\n") : "(nothing yet)",
    "",
    "# Schedule",
    `Only add, change or delete events when the user explicitly tells you to (\"add…\", \"schedule…\", \"remind me…\", \"move…\", \"cancel…\"). Mentioning a plan (\"I have gym at 6\", \"dentist on Tuesday\") is not a request: don't add it, don't suggest remembering it, and don't ask whether to add it — just reply naturally. Times are the user's local time unless they say otherwise; work out dates like \"tomorrow\" or \"next Tuesday\" from the current date. Confirm with the day, date and time. Before adding, if the day or AM/PM wasn't said (\"at 2\", \"Friday\" when today is Friday) — or the request was spoken (the request notes say \"Heard by voice\") and the day or time could have been misheard — ask with ask_user, offering the likely choices (e.g. \"Today, 2:00 PM\" / \"Tomorrow, 2:00 PM\"). If it's clear, just add it. Reminders appear ${lead ? `${lead} minutes before and ` : ""}at the start while E.V is open.`,
    "Next 7 days:",
    soon.length ? soon.map((o) => `- [${o.event.id}] ${describeEvent(o.event, o.at)}`).join("\n") : "(nothing scheduled)",
    // No clock here: the time comes with each request (see nowNote), so these instructions stay
    // the same and the provider's cache discount covers them.
  ].join("\n");
}
