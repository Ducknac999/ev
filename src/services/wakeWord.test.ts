import { describe, expect, it } from "vitest";
import { findWake, isEndPhrase, isStopCommand, parseWake, soundsUnfinished } from "./wakeWord";

describe("Hey E.V", () => {
  it("takes only what follows the wake phrase", () => {
    expect(parseWake("Hey E.V, what's two plus two?")).toEqual({ wake: true, rest: "what's two plus two?" });
    expect(parseWake("Hi Evie what's the weather")).toEqual({ wake: true, rest: "what's the weather" });
    expect(parseWake("Hey Eevee, Pause the music.")).toEqual({ wake: true, rest: "Pause the music." });
    expect(parseWake("HEV. Pause the music.")).toEqual({ wake: true, rest: "Pause the music." });
    expect(parseWake("Havy, pause the music.")).toEqual({ wake: true, rest: "pause the music." });
    expect(parseWake("Hey V, pause the music.")).toEqual({ wake: true, rest: "pause the music." });
    expect(parseWake("Hey EV what time is it")).toEqual({ wake: true, rest: "what time is it" });
    expect(parseWake("Okay E.V.")).toEqual({ wake: true, rest: "" });
    expect(parseWake("Hey, getting the groceries later?")).toEqual({ wake: false, text: "Hey, getting the groceries later?" });
    expect(parseWake("Say E.V, pause the music.")).toEqual({ wake: true, rest: "pause the music." });
    expect(parseWake("hey, E.V — play music")).toEqual({ wake: true, rest: "play music" });
  });

  it("ignores speech without it", () => {
    expect(parseWake("What's two plus two?")).toEqual({ wake: false, text: "What's two plus two?" });
    expect(parseWake("I told E.V yesterday")).toEqual({ wake: false, text: "I told E.V yesterday" });
    expect(parseWake("Hey Gary, how are you")).toEqual({ wake: false, text: "Hey Gary, how are you" });
    expect(parseWake("Hey, every time I open it")).toEqual({ wake: false, text: "Hey, every time I open it" });
    expect(parseWake("Heavy rain today")).toEqual({ wake: false, text: "Heavy rain today" });
    expect(parseWake("Hey Evan, come here")).toEqual({ wake: false, text: "Hey Evan, come here" });
  });

  it("recognises ending and stopping", () => {
    for (const t of ["That's all", "thanks E.V", "Thank you, E.V.", "Thanks, Eevee.", "Thanks EV", "never mind", "I'm done"]) expect(isEndPhrase(t), t).toBe(true);
    expect(isEndPhrase("that's all the files you need to read")).toBe(false);
    expect(isStopCommand("stop")).toBe(true);
    expect(isStopCommand("stop the music in Spotify")).toBe(false);
  });

  it("knows when a sentence isn't finished yet", () => {
    for (const t of ["Hey E.V, open Discord, go to my chat with Chris,", "tell him that", "open the file and", "send it to um"]) expect(soundsUnfinished(t), t).toBe(true);
    for (const t of ["Hey E.V, pause the music.", "What's the weather?", "open Discord. Go to my chat with Chris.", ""]) expect(soundsUnfinished(t), t).toBe(false);
  });

  it("finds Hey E.V anywhere while E.V is talking", () => {
    expect(findWake("Look at the mapping for G. Hey E.V, stop.")).toEqual({ rest: "stop." });
    expect(findWake("Then use the table. Hey Evie, stop.")).toEqual({ rest: "stop." });
    expect(findWake("for f to find HEV stop")).toEqual({ rest: "stop" });
    expect(findWake("Hey Eevee")).toEqual({ rest: "" });
    expect(findWake("Plug in a V value and every step.")).toBeNull();
    expect(findWake("Anything. A E V, stop.")).toEqual({ rest: "stop." });
    expect(findWake("A EV, stop.")).toEqual({ rest: "stop." });
    expect(findWake("Dear Evie, stop.")).toEqual({ rest: "stop." });
    expect(findWake("Maybe. Hey E.B., what's the weather?")).toEqual({ rest: "what's the weather?" });
    expect(findWake("Hey A. V, pause the music.")).toEqual({ rest: "pause the music." });
    expect(findWake("Use a vertical line test.")).toBeNull();
    expect(findWake("KE V Stop")).toEqual({ rest: "Stop" });
    expect(findWake("Hi Easy. I need the stop.")).toEqual({ rest: "I need the stop." });
    expect(findWake("It's easy to see the pattern.")).toBeNull();
    expect(findWake("Anything. ADD, stop.")).toEqual({ rest: "stop." });
    expect(findWake("How do you do? A ED, stop.")).toEqual({ rest: "stop." });
    expect(findWake("Add the two numbers, then stop.")).toBeNull();
    expect(findWake("Then use the table for f to find which x value.")).toBeNull();
    expect(findWake("Hey, getting the groceries later?")).toBeNull();
    expect(findWake("I want to buy an EV next year.")).toBeNull();
  });
});
