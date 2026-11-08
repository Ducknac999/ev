import { describe, expect, it } from "vitest";
import { parseQuickCommand } from "./quickCommands";

describe("instant commands", () => {
  it("recognises simple media and system commands", () => {
    expect(parseQuickCommand("Pause the music.")).toEqual({ kind: "media", action: "pause" });
    expect(parseQuickCommand("can you pause the music please")).toEqual({ kind: "media", action: "pause" });
    expect(parseQuickCommand("Play music")).toEqual({ kind: "media", action: "play" });
    expect(parseQuickCommand("resume")).toEqual({ kind: "media", action: "play" });
    expect(parseQuickCommand("next song")).toEqual({ kind: "media", action: "next" });
    expect(parseQuickCommand("Skip this")).toEqual({ kind: "media", action: "next" });
    expect(parseQuickCommand("go back to the previous song")).toBeNull();
    expect(parseQuickCommand("previous song")).toEqual({ kind: "media", action: "previous" });
    expect(parseQuickCommand("volume up")).toEqual({ kind: "volume", by: 10 });
    expect(parseQuickCommand("set the volume to 30")).toEqual({ kind: "volume", to: 30 });
    expect(parseQuickCommand("volume fifty percent")).toEqual({ kind: "volume", to: 50 });
    expect(parseQuickCommand("mute")).toEqual({ kind: "mute", on: true });
    expect(parseQuickCommand("turn on dark mode")).toEqual({ kind: "dark", on: true });
    expect(parseQuickCommand("turn off dark mode")).toEqual({ kind: "dark", on: false });
    expect(parseQuickCommand("open discord")).toEqual({ kind: "open", app: "Discord" });
  });

  it("takes the value first too, and spoken math", () => {
    expect(parseQuickCommand("max volume.")).toEqual({ kind: "volume", to: 100 });
    expect(parseQuickCommand("100% volume.")).toEqual({ kind: "volume", to: 100 });
    expect(parseQuickCommand("A hundred percent volume.")).toEqual({ kind: "volume", to: 100 });
    expect(parseQuickCommand("volume all the way up")).toEqual({ kind: "volume", to: 100 });
    expect(parseQuickCommand("half volume")).toEqual({ kind: "volume", to: 50 });
    expect(parseQuickCommand("what is two times uh three times four?")).toMatchObject({ kind: "math", spoken: "24." });
  });

  it("leaves anything more to the AI", () => {
    for (const t of [
      "pause the music and tell Chris I'm busy",
      "open YouTube Music in Vivaldi",
      "open my downloads folder",
      "what song is playing",
      "play some jazz",
      "stop talking about the weather",
      "next, tell me the weather",
    ]) {
      expect(parseQuickCommand(t), t).toBeNull();
    }
  });
});

describe("hands-free commands (spoken only)", () => {
  it("act on the app in front when said out loud", () => {
    expect(parseQuickCommand("type fix the failing tests", true)).toEqual({ kind: "type", text: "fix the failing tests" });
    expect(parseQuickCommand("send it", true)).toEqual({ kind: "key", key: "return", shift: false });
    expect(parseQuickCommand("new line", true)).toEqual({ kind: "key", key: "return", shift: true });
    expect(parseQuickCommand("delete that", true)).toEqual({ kind: "undo" });
    expect(parseQuickCommand("click submit", true)).toEqual({ kind: "click", label: "submit" });
    expect(parseQuickCommand("take a screenshot", true)).toEqual({ kind: "screenshot" });
    expect(parseQuickCommand("screenshot into slack", true)).toEqual({ kind: "screenshot", into: "Slack" });
    expect(parseQuickCommand("add Vorssaint to my dictionary", true)).toEqual({ kind: "dictionary", word: "Vorssaint" });
    // Not a button called "play": that one is for the music (the router takes it).
    expect(parseQuickCommand("hit play", true)).toBeNull();
  });

  it("never fire from typing", () => {
    expect(parseQuickCommand("send it")).toBeNull();
    expect(parseQuickCommand("type fix the tests")).toBeNull();
  });
});
