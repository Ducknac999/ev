import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications: string[] = [];
vi.mock("../lib/ipc", () => ({
  showNotification: async (title: string, body: string) => void notifications.push(`${title} | ${body}`),
  passphraseCheck: async (text: string) => /copper lantern/i.test(text),
  vaultLoad: async () => "",
  vaultSave: async () => {},
  calendarSync: async () => {},
}));
const confirmations: string[] = [];
vi.mock("./announce", () => ({
  announceImportant: async (text: string) => void confirmations.push(`spoken: ${text}`),
  confirmQuietly: async (text: string) => void confirmations.push(`chime: ${text}`),
}));
vi.mock("../audio/speech", () => ({ speechQueue: { feed: () => {}, stop: () => {} } }));

const { occurrences, upcoming, checkReminders, describeEvent } = await import("./schedule");
const { useVault, parseVault } = await import("../store/vault");
const { executeMemoryTool, memoryPrompt } = await import("../providers/agent/memoryTools");
const { parseInstant } = await import("../providers/agent/liveTools");

const LA = "America/Los_Angeles";
const at = (wall: string) => parseInstant(wall, LA);
const event = (start: string, repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" = "none", until?: string) => ({
  id: "e1",
  title: "Gym",
  start,
  timeZone: LA,
  repeat,
  until,
  createdAt: 0,
});

beforeEach(() => {
  notifications.length = 0;
  useVault.setState({ ...parseVault(""), loaded: true, error: null });
});

describe("occurrences", () => {
  it("expands repeats in local time, across daylight saving", () => {
    const weekly = occurrences(event("2026-10-24 18:00", "weekly"), at("2026-10-01 00:00"), at("2026-11-15 00:00"));
    expect(weekly.map((o) => describeEvent(o.event, o.at))).toEqual([
      "Gym · Sat, Oct 24, 2026, 6:00 PM PDT · every week",
      "Gym · Sat, Oct 31, 2026, 6:00 PM PDT · every week",
      "Gym · Sat, Nov 7, 2026, 6:00 PM PST · every week",
      "Gym · Sat, Nov 14, 2026, 6:00 PM PST · every week",
    ]);
  });

  it("skips weekends for weekdays and stops at until", () => {
    const list = occurrences(event("2026-10-09 07:00", "weekdays", "2026-10-14"), at("2026-10-01 00:00"), at("2026-12-01 00:00"));
    expect(list.map((o) => new Date(o.at).getUTCDate())).toEqual([9, 12, 13, 14]);
  });

  it("skips months without the day", () => {
    const list = occurrences(event("2026-01-31 09:00", "monthly"), at("2026-01-01 00:00"), at("2026-06-01 00:00"));
    expect(list).toHaveLength(3); // Jan, Mar, May
  });

  it("orders events together", () => {
    useVault.getState().addEvent({ title: "Dentist", start: "2026-10-13 15:00", timeZone: LA, repeat: "none" });
    useVault.getState().addEvent({ title: "Gym", start: "2026-10-10 18:00", timeZone: LA, repeat: "none" });
    expect(upcoming(useVault.getState().schedule, at("2026-10-09 00:00"), at("2026-10-31 00:00")).map((o) => o.event.title)).toEqual(["Gym", "Dentist"]);
  });
});

describe("reminders", () => {
  it("fires 10 minutes before and at the start, once each", () => {
    useVault.getState().addEvent({ title: "Gym", start: "2026-10-10 18:00", timeZone: LA, repeat: "none" });
    checkReminders(at("2026-10-10 17:40"));
    expect(notifications).toEqual([]);
    checkReminders(at("2026-10-10 17:50"));
    checkReminders(at("2026-10-10 17:51"));
    expect(notifications).toEqual(["E.V · Gym | In 10 minutes, at 6:00 PM"]);
    checkReminders(at("2026-10-10 18:00"));
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain("Now · 6:00 PM");
  });

  it("doesn't show reminders that were missed while E.V was closed", () => {
    useVault.getState().addEvent({ title: "Gym", start: "2026-10-10 18:00", timeZone: LA, repeat: "none" });
    checkReminders(at("2026-10-10 19:00"));
    expect(notifications).toEqual([]);
  });
});

describe("teaching", () => {
  const ctx = { chatId: "chat-1", chatTitle: "Weather", stepId: "step-1" };

  it("remembers, updates instead of duplicating, and can undo", async () => {
    const first = await executeMemoryTool("remember", { text: "Lives in Los Angeles", kind: "about", scope: "gideon" }, ctx);
    expect(first.ok).toBe(true);
    const id = useVault.getState().memories[0].id;
    const moved = await executeMemoryTool("remember", { text: "Lives in Springfield, California", kind: "about", scope: "gideon", replaces: id }, { ...ctx, stepId: "step-2" });
    expect(useVault.getState().memories).toHaveLength(1);
    expect(useVault.getState().memories[0].text).toBe("Lives in Springfield, California");
    expect(moved.undo).toMatchObject({ type: "memory", id, before: { text: "Lives in Los Angeles" } });
    expect(memoryPrompt("chat-1")).toContain(`[${id}] (about) Lives in Springfield, California`);
  });

  it("keeps chat memory to its own chat", async () => {
    await executeMemoryTool("remember", { text: "This project uses React", kind: "note", scope: "chat" }, ctx);
    expect(memoryPrompt("chat-1")).toContain("This project uses React");
    expect(memoryPrompt("chat-2")).not.toContain("This project uses React");
  });

  it("never stores secrets or the passphrase", async () => {
    for (const text of ["My password is hunter2", "API key AIzaSyA1234567890abcdefghijklmnop", "card 4111 1111 1111 1111", "my approval words are copper lantern nine"]) {
      const out = await executeMemoryTool("remember", { text, kind: "note", scope: "gideon" }, ctx);
      expect(out.ok, text).toBe(false);
    }
    expect(useVault.getState().memories).toHaveLength(0);
  });

  it("adds, moves and deletes events only when the user asks", async () => {
    const mentioned = await executeMemoryTool("schedule_add", { title: "Dentist", start: "2030-10-15 15:00" }, { ...ctx, userText: "I have a dentist appointment at 3 on Tuesday." });
    expect(mentioned.ok).toBe(false);
    expect(useVault.getState().schedule).toHaveLength(0);
    const added = await executeMemoryTool("schedule_add", { title: "Gym", start: "2030-10-10 18:00", repeat: "weekly" }, { ...ctx, userText: "Add gym at 6 PM every Thursday" });
    expect(added.display).toBe("Gym · Thu, Oct 10, 2030, 6:00 PM PDT · every week");
    const id = useVault.getState().schedule[0].id;
    await executeMemoryTool("schedule_update", { id, start: "2030-10-10 19:00" }, { ...ctx, userText: "Move gym to 7" });
    expect(useVault.getState().schedule[0].start).toBe("2030-10-10 19:00");
    expect((await executeMemoryTool("schedule_delete", { id }, { ...ctx, userText: "gym was great" })).ok).toBe(false);
    const removed = await executeMemoryTool("schedule_delete", { id }, { ...ctx, userText: "Cancel gym" });
    expect(removed.undo).toMatchObject({ type: "event-removed" });
    expect(useVault.getState().schedule).toHaveLength(0);
  });

  it("reads a reminder back out loud only when it was asked by voice", async () => {
    confirmations.length = 0;
    await executeMemoryTool("schedule_add", { title: "Scouts", start: "2030-10-10 18:00" }, { ...ctx, userText: "remind me to get ready for scouts at 6" });
    await executeMemoryTool("schedule_add", { title: "Scouts", start: "2030-10-11 18:00" }, { ...ctx, userText: "remind me to get ready for scouts at 6", heardByVoice: true });
    expect(confirmations.map((c) => c.split(":")[0])).toEqual(["chime", "spoken"]);
  });

  it("reads back only well-formed vault data", () => {
    const data = parseVault(JSON.stringify({ memories: [{ id: "m", text: "x", scope: "gideon", kind: "weird" }, { text: "no id" }], schedule: [{ nope: 1 }] }));
    expect(data.memories).toEqual([{ id: "m", text: "x", scope: "gideon", kind: "note" }]);
    expect(data.schedule).toEqual([]);
  });
});

describe("plans are never offered as memories", () => {
  it("refuses suggestions that are appointments", async () => {
    const { looksLikePlan } = await import("../providers/agent/memoryTools");
    expect(looksLikePlan("Dentist appointment at 3 PM on Tuesdays.")).toBe(true);
    expect(looksLikePlan("Gym at 6 tomorrow")).toBe(true);
    expect(looksLikePlan("Sister's name is Ayesha")).toBe(false);
    expect(looksLikePlan("Is learning Swift")).toBe(false);
    const out = await executeMemoryTool("suggest_memory", { text: "Dentist appointment at 3 PM on Tuesday", kind: "note" }, { chatId: "c", chatTitle: "t", stepId: "s" });
    expect(out.ok).toBe(false);
  });
});
