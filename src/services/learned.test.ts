import { describe, expect, it } from "vitest";
import { findLearned, learnedKey, meaningKey, type LearnedTask } from "./learned";

const task = (request: string): LearnedTask => ({ id: request, request, key: learnedKey(request), steps: [{ tool: "mac_open", args: { app: "Notes" } }], reply: "Done.", createdAt: 0, uses: 0 });

describe("learned tasks", () => {
  it("matches the same request said another way", () => {
    const tasks = [task("open my study setup")];
    expect(findLearned("Hey E.V, can you open the study setup please", tasks)?.id).toBe("open my study setup");
    expect(findLearned("launch my study setup", tasks)?.id).toBe("open my study setup");
  });

  it("never matches a different request", () => {
    const tasks = [task("open my study setup"), task("move notes to archive")];
    expect(findLearned("open my work setup", tasks)).toBeNull();
    expect(findLearned("move archive to notes", tasks)).toBeNull();
    expect(findLearned("open my study setup in chrome", tasks)).toBeNull();
  });

  it("drops only small words", () => {
    expect(meaningKey("set up the cstimer colors like the video")).toBe("set cstimer color like video");
  });
});
