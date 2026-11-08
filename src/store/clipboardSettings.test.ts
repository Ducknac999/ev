import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeClipboard } from "./settings";

describe("clipboard settings", () => {
  it("is on with ⌘⇧C for new installs and older settings", () => {
    expect(DEFAULT_SETTINGS.notch.clipboard.shortcut).toBe("shift+command+c");
    const fromOld = normalizeClipboard(undefined);
    expect(fromOld.enabled).toBe(true);
    expect(fromOld.shortcut).toBe("shift+command+c");
    expect(fromOld.limit).toBe(100);
    expect(fromOld.ignoreApps).toContain("1Password");
  });

  it("keeps the user's choices and fixes bad ones", () => {
    const c = normalizeClipboard({ enabled: false, shortcut: "control+option+v", limit: 5000, ignoreApps: ["Slack", "", 3] });
    expect(c).toEqual({ enabled: false, shortcut: "control+option+v", limit: 1000, ignoreApps: ["Slack"] });
    expect(normalizeClipboard({ limit: 2 }).limit).toBe(100);
  });
});
