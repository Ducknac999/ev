import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { url: string; body: Record<string, unknown> }[] = [];
let reply: string[] = [];

vi.mock("../../lib/ipc", () => ({
  providerStream: async (url: string, _headers: unknown, body: Record<string, unknown>, onChunk: (c: string) => void) => {
    sent.push({ url, body });
    for (const chunk of reply) onChunk(chunk);
    return {};
  },
  attachmentRead: async () => null,
}));

const { ADAPTERS } = await import("./adapters");
const { apiModel, canThink, seesImages, PROVIDERS, upgradeModel, DEEPSEEK_FLASH } = await import("../catalog");
const { unsupportedReason } = await import("../../lib/attachments");
const { textOnlyMessages } = await import("../attachmentPayload");

const sse = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const base = { key: "k", system: "sys", tools: [], signal: new AbortController().signal, onText: () => {} };

beforeEach(() => {
  sent.length = 0;
  reply = [sse({ content: "hi" }), "data: [DONE]\n\n"];
});

describe("DeepSeek models", () => {
  it("lists only the current models, with Vision as a separate Flash entry", () => {
    expect(PROVIDERS.deepseek.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-flash-vision", "deepseek-v4-pro"]);
    expect(apiModel("deepseek-flash-vision")).toBe("deepseek-flash");
    expect(apiModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(seesImages("deepseek-flash-vision")).toBe(true);
    expect(seesImages("deepseek-flash")).toBe(false);
    expect(seesImages("deepseek-v4-pro")).toBe(false);
    expect(canThink({ provider: "deepseek", model: "deepseek-v4-pro" })).toBe(true);
    expect(canThink({ provider: "groq", model: "llama-3.3-70b-versatile" })).toBe(false);
  });

  it("moves the shut-down model names to the current ones", () => {
    expect(upgradeModel({ provider: "deepseek", model: "deepseek-chat" }, DEEPSEEK_FLASH)).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(upgradeModel({ provider: "deepseek", model: "deepseek-reasoner" }, DEEPSEEK_FLASH)).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("lets only the Vision model take image attachments", () => {
    const image = { kind: "image" as const, size: 10, name: "a.png" };
    expect(unsupportedReason({ provider: "deepseek", model: "deepseek-flash-vision" }, image)).toBeNull();
    expect(unsupportedReason({ provider: "deepseek", model: "deepseek-flash" }, image)).toMatch(/can't read/);
    expect(unsupportedReason({ provider: "deepseek", model: "deepseek-v4-pro" }, image)).toMatch(/can't read/);
  });
});

describe("DeepSeek requests", () => {
  it("sends the real model name and thinking off by default", async () => {
    await ADAPTERS.deepseek.step({ ...base, model: "deepseek-flash-vision", conversation: [{ role: "user", content: "q" }] });
    expect(sent[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent[0].body.model).toBe("deepseek-flash");
    expect(sent[0].body.thinking).toEqual({ type: "disabled" });
  });

  it("with thinking on: asks for it, streams the reasoning and keeps it on the reply", async () => {
    reply = [sse({ reasoning_content: "let me " }), sse({ reasoning_content: "see" }), sse({ content: "42" }), "data: [DONE]\n\n"];
    const thoughts: string[] = [];
    const out = await ADAPTERS.deepseek.step({
      ...base,
      model: "deepseek-v4-pro",
      thinking: true,
      onThinking: (d) => thoughts.push(d),
      conversation: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2", reasoning_content: "kept" },
        { role: "user", content: "q2" },
      ],
    });
    expect(sent[0].body.thinking).toEqual({ type: "enabled" });
    const messages = sent[0].body.messages as { role: string; reasoning_content?: string }[];
    // Every earlier assistant message carries reasoning (empty when it had none), as DeepSeek requires.
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content)).toEqual(["", "kept"]);
    expect(thoughts.join("")).toBe("let me see");
    expect(out.text).toBe("42");
    expect((out.item as { reasoning_content?: string }).reasoning_content).toBe("let me see");
  });

  it("sends tool pictures only to the Vision model", () => {
    const results = [{ call: { id: "c", name: "mac_look", args: {} }, output: "window", image: "AAAA" }];
    const vision = ADAPTERS.deepseek.toolResults(results, "deepseek-flash-vision") as { role: string; content: unknown }[];
    expect(vision.some((m) => m.role === "user" && JSON.stringify(m.content).includes("data:image/jpeg;base64,AAAA"))).toBe(true);
    const plain = ADAPTERS.deepseek.toolResults(results, "deepseek-flash") as { role: string; content: unknown }[];
    expect(plain.some((m) => m.role === "user")).toBe(false);
    expect(String(plain[0].content)).toMatch(/can't view images/);
  });

  it("puts the user's attached pictures in as images for the Vision model", async () => {
    const load = async () => new TextEncoder().encode("PNG").buffer as ArrayBuffer;
    const history = [
      { id: "1", role: "user" as const, content: "what is this", createdAt: 0, attachments: [{ id: "a", name: "p.png", mime: "image/png", size: 3, kind: "image" as const, path: "/p.png" }] },
    ];
    const vision = await textOnlyMessages(history, load, true);
    expect(Array.isArray(vision[0].content)).toBe(true);
    expect(JSON.stringify(vision[0].content)).toContain("data:image/png;base64,");
    const plain = await textOnlyMessages(history, load, false);
    expect(plain[0].content).toContain("this model can't view it");
  });
});
