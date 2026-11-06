import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "../types";

const sent: { text: string; files: string[] }[] = [];
vi.mock("./chatRunner", () => ({
  isRunning: () => false,
  stopGeneration: () => {},
  sendMessage: async (_id: string, text: string, options: { attachments?: Attachment[] }) => {
    sent.push({ text, files: (options.attachments ?? []).map((a) => a.name) });
  },
}));
vi.mock("./terminals", () => ({ writeToTerminal: () => {}, useTerminals: () => ({}) }));
vi.mock("../audio/speech", () => ({ speechQueue: { feed: () => {}, stop: () => {}, prewarm: () => {} } }));

const photo: Attachment = { id: "a1", name: "graph.png", mime: "image/png", size: 10, kind: "image", path: "/tmp/graph.png" };

describe("Talk mode with attached files", () => {
  it("sends the attached image along with what was said", async () => {
    const { conversation } = await import("./voiceControl");
    const { useDrafts } = await import("../store/drafts");
    useDrafts.setState({ byChat: { c1: [{ id: "d1", name: "graph.png", size: 10, status: "ready", attachment: photo }] } });
    conversation.deliver("c1", "look at this image and tell me the slope");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ text: "look at this image and tell me the slope", files: ["graph.png"] });
    // The draft is emptied, like pressing Enter.
    expect(useDrafts.getState().byChat.c1 ?? []).toEqual([]);
  });

  it("waits for a file that's still uploading", async () => {
    const { conversation } = await import("./voiceControl");
    const { useDrafts } = await import("../store/drafts");
    useDrafts.setState({ byChat: { c2: [{ id: "d2", name: "notes.pdf", size: 10, status: "uploading" }] } });
    conversation.deliver("c2", "summarize this");
    setTimeout(() => useDrafts.setState({ byChat: { c2: [{ id: "d2", name: "notes.pdf", size: 10, status: "ready", attachment: { ...photo, id: "a2", name: "notes.pdf", kind: "pdf" as Attachment["kind"] } }] } }), 300);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 3000 });
    expect(sent[1]).toEqual({ text: "summarize this", files: ["notes.pdf"] });
  });
});
