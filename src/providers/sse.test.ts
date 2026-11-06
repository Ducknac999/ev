import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

describe("SseParser", () => {
  it("reassembles events split across chunks", () => {
    const out: string[] = [];
    const parser = new SseParser((d) => out.push(d));
    parser.push('data: {"a":');
    parser.push('1}\r\n\r\ndata: [DONE]\n');
    parser.push("\n: keep-alive\n\n");
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("captures handler errors instead of throwing into the transport", () => {
    const parser = new SseParser(() => {
      throw new Error("boom");
    });
    parser.push("data: x\n\n");
    expect(parser.error?.message).toBe("boom");
  });
});
