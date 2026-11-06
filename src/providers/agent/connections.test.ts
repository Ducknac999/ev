import { describe, expect, it } from "vitest";
import { cleanSchema, connectionCategory, registerForTest, toolName } from "./connections";
import { categoryFor, DEFAULT_RULES, decide } from "./policy";

const ctx = { cwd: "/p", home: "/Users/u", hasProject: true, readLocal: false, taskApps: new Set<string>(), neverApps: [] };

describe("connected tools follow the approval rules", () => {
  const gmailSearch = registerForTest("google", { name: "search_gmail_messages", readOnly: true });
  const gmailSend = registerForTest("google", { name: "send_gmail_message" });
  const gmailDraft = registerForTest("google", { name: "draft_gmail_message" });
  const eventDelete = registerForTest("google", { name: "delete_event" });
  const reminderAdd = registerForTest("apple", { name: "create_reminder" });
  const notesRead = registerForTest("apple", { name: "list_notes" });
  const navigate = registerForTest("browser", { name: "browser_navigate" });
  const click = registerForTest("browser", { name: "browser_click" });
  const transcript = registerForTest("youtube", { name: "get_transcript" });

  const level = (name: string, args: Record<string, unknown> = {}) => decide(categoryFor(name, args, ctx), DEFAULT_RULES.levels, null, name, args, ctx);

  it("reads without asking", () => {
    expect(level(gmailSearch, { query: "from:chris" })).toBe("run");
    expect(level(notesRead)).toBe("run");
    expect(level(transcript, { url: "https://youtu.be/x" })).toBe("run");
    expect(level(navigate, { url: "https://example.com" })).toBe("run");
    expect(level(click, { element: "Next page link" })).toBe("run");
  });

  it("asks before changing things", () => {
    expect(level(gmailDraft, { to: "a@b.c" })).toBe("approve");
    expect(level(reminderAdd, { title: "milk" })).toBe("approve");
  });

  it("previews sending and deleting", () => {
    expect(level(gmailSend, { to: "a@b.c" })).toBe("final");
    expect(level(eventDelete, { id: "1" })).toBe("final");
    expect(level(click, { element: "Send button" })).toBe("final");
  });

  it("never touches money or passwords", () => {
    expect(level(navigate, { url: "https://www.amazon.com/gp/buy/checkout" })).toBe("never");
    expect(level(click, { element: "Place order button" })).toBe("never");
    expect(level(click, { element: "Pay now" })).toBe("never");
    expect(connectionCategory(registerForTest("browser", { name: "browser_type" }), { element: "Password field", text: "x" })).toBe("passwords");
  });

  it("makes names Gemini accepts", () => {
    expect(toolName("google", "send-gmail.message!")).toBe("c_google__send-gmail.message_");
    expect(toolName("x", "a".repeat(100)).length).toBe(64);
  });

  it("simplifies schemas to what Gemini understands", () => {
    const schema = cleanSchema({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        to: { type: ["string", "null"], description: "Recipient" },
        count: { anyOf: [{ type: "integer" }, { type: "null" }] },
        labels: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
      required: ["to", "missing"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient" },
        count: { type: "integer" },
        labels: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
      required: ["to"],
    });
  });
});
