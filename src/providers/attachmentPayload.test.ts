import { describe, expect, it } from "vitest";
import { classify, GEMINI_INLINE_BUDGET, unsupportedReason } from "../lib/attachments";
import type { Attachment, ChatMessage } from "../types";
import { geminiContents, textOnlyMessages, toBase64 } from "./attachmentPayload";

const att = (patch: Partial<Attachment>): Attachment => ({
  id: patch.name ?? "a",
  name: "a",
  mime: "application/octet-stream",
  size: 4,
  kind: "binary",
  path: `/store/${patch.name ?? "a"}`,
  ...patch,
});
const msg = (role: ChatMessage["role"], content: string, attachments?: Attachment[]): ChatMessage => ({
  id: Math.random().toString(36),
  role,
  content,
  attachments,
  createdAt: 0,
});
const files: Record<string, string> = {
  "/store/notes.md": "# Plan\nship it",
  "/store/photo.png": "PNGDATA",
  "/store/big.pdf": "PDF",
};
const load = async (path: string) => (path in files ? new TextEncoder().encode(files[path]).buffer as ArrayBuffer : null);

describe("attachment classification", () => {
  it("detects kinds from type, extension and content", () => {
    const text = new TextEncoder().encode("hello");
    expect(classify("shot.png", "image/png", text)).toBe("image");
    expect(classify("doc.pdf", "", text)).toBe("pdf");
    expect(classify("main.rs", "", text)).toBe("text");
    expect(classify("Dockerfile", "", text)).toBe("text");
    expect(classify("logo.svg", "image/svg+xml", text)).toBe("text");
    expect(classify("data.bin", "", new Uint8Array([0, 1, 2]))).toBe("binary");
    expect(classify("memo", "", text)).toBe("text");
    expect(classify("clip.mp3", "audio/mpeg", text)).toBe("audio");
  });

  it("knows which models can read what", () => {
    const gemini = { provider: "gemini", model: "gemini-3.5-flash" } as const;
    const groq = { provider: "groq", model: "llama-3.3-70b-versatile" } as const;
    const claude = { provider: "claude", model: "default" } as const;
    const image = att({ name: "p.png", kind: "image" });
    expect(unsupportedReason(gemini, image)).toBeNull();
    expect(unsupportedReason(claude, image)).toBeNull();
    expect(unsupportedReason(groq, image)).toBe("Llama 3.3 70B can't read images");
    expect(unsupportedReason(groq, att({ kind: "text" }))).toBeNull();
    expect(unsupportedReason(claude, att({ kind: "audio" }))).toMatch(/can't read audio/);
    expect(unsupportedReason(gemini, att({ name: "huge.mp4", kind: "video", size: GEMINI_INLINE_BUDGET + 1 }))).toMatch(/19 MB/);
  });
});

describe("provider payloads", () => {
  it("inlines Gemini attachments before the message text", async () => {
    const contents = await geminiContents(
      [
        msg("user", "what is this?", [att({ name: "photo.png", mime: "image/png", kind: "image" }), att({ name: "notes.md", kind: "text" })]),
        msg("assistant", "a photo"),
      ],
      load,
    );
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: toBase64(new TextEncoder().encode("PNGDATA")) } });
    expect((contents[0].parts[1] as { text: string }).text).toContain("Attached file: notes.md\n```\n# Plan\nship it\n```");
    expect(contents[0].parts[2]).toEqual({ text: "what is this?" });
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "a photo" }] });
  });

  it("drops the oldest binary attachments once the Gemini budget is spent", async () => {
    const big = att({ name: "big.pdf", mime: "application/pdf", kind: "pdf", size: GEMINI_INLINE_BUDGET - 2 });
    const contents = await geminiContents([msg("user", "old", [big]), msg("user", "new", [att({ name: "photo.png", kind: "image", mime: "image/png", size: 7 })])], load);
    expect((contents[0].parts[0] as { text: string }).text).toMatch(/omitted/);
    expect("inlineData" in contents[1].parts[0]).toBe(true);
  });

  it("notes files that were deleted", async () => {
    const contents = await geminiContents([msg("user", "", [att({ name: "gone.png", kind: "image" })])], load);
    expect(contents[0].parts).toEqual([{ text: '[Attached file "gone.png" is no longer available]' }]);
  });

  it("gives text-only models file contents and a note for everything else", async () => {
    const out = await textOnlyMessages([msg("user", "review", [att({ name: "notes.md", kind: "text" }), att({ name: "photo.png", kind: "image" })])], load);
    expect(out[0].content!).toContain("# Plan");
    expect(out[0].content!).toContain(`[Attached image "photo.png" — this model can't view it]`);
    expect((out[0].content as string).endsWith("review")).toBe(true);
  });

});
