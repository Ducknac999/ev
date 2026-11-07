import { describe, expect, it, vi } from "vitest";

const opened: string[] = [];
vi.mock("@tauri-apps/api/event", () => ({ emitTo: async () => {} }));
vi.mock("../lib/ipc", () => ({
  fileOpen: async (path: string) => void opened.push(path),
  findMyFiles: async (query: string) =>
    query.includes("resume")
      ? {
          key: "resume",
          clear: false,
          empty: false,
          results: [
            { path: "/u/Documents/Resume 2026.pdf", name: "Resume 2026.pdf", folder: "Documents", when: "yesterday", score: 90, named: true },
            { path: "/u/Downloads/Resume old.docx", name: "Resume old.docx", folder: "Downloads", when: "Mar 3", score: 70, named: true },
          ],
        }
      : query.includes("essay")
        ? { key: "essay", clear: true, empty: false, results: [{ path: "/u/Documents/Essay.pages", name: "Essay.pages", folder: "Documents", when: "today", score: 95, named: true }] }
        : { key: "", clear: false, empty: false, results: [] },
}));

const { fileRequest, findFile, parsePick, pickFile } = await import("./filePicker");

describe("instant file search", () => {
  it("knows a file request from an app or a place", () => {
    expect(fileRequest("find my resume")).toBe("find my resume");
    expect(fileRequest("Hey E.V, open my latest tax return")).toBe("open my latest tax return");
    expect(fileRequest("open the budget spreadsheet")).toBe("open the budget spreadsheet");
    expect(fileRequest("where is my essay")).toBe("where is my essay");
    expect(fileRequest("open Spotify")).toBeNull();
    expect(fileRequest("open my downloads folder")).toBeNull();
    expect(fileRequest("what's the weather")).toBeNull();
  });

  it("opens a clear match, asks on a close call, and takes the pick by number", async () => {
    expect(await findFile("find my essay")).toBe("Opening Essay.pages.");
    expect(opened).toEqual(["/u/Documents/Essay.pages"]);
    const asked = await findFile("find my resume");
    expect(typeof asked).toBe("object");
    expect(parsePick("the second one")).toBe(2);
    expect(parsePick("open number 1")).toBe(1);
    expect(parsePick("the ninth one")).toBeNull();
    expect(await pickFile(2)).toBe("Opening Resume old.docx.");
    expect(opened.at(-1)).toBe("/u/Downloads/Resume old.docx");
    // The list is gone after a pick.
    expect(parsePick("the first one")).toBeNull();
  });

  it("leaves it to the AI when Spotlight finds nothing", async () => {
    await expect(findFile("find my unicorn")).rejects.toThrow();
  });
});
