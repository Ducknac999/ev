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
