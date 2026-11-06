import { describe, expect, it } from "vitest";
import { calculate, convertTime, convertUnits, formatInstant, parseInstant, sports, weather, wikipedia } from "./liveTools";

const LA = "America/Los_Angeles";

describe("time zones", () => {
  it("converts race times to the user's zone", () => {
    expect(convertTime("2026-10-11T12:00:00Z", "", LA)).toContain("Sun, Oct 11, 2026, 5:00 AM PDT");
    expect(convertTime("2026-10-11 20:00", "Asia/Singapore", LA)).toContain("5:00 AM PDT");
    expect(convertTime("2026-10-11 8:00 pm", "SGT", "PT")).toContain("5:00 AM PDT");
  });

  it("handles daylight-saving changes", () => {
    // Nov 1 2026 01:30 is ambiguous in LA; 2026-03-08 03:30 is after the spring-forward gap.
    expect(formatInstant(parseInstant("2026-03-08 03:30", LA), LA)).toContain("3:30 AM PDT");
    expect(formatInstant(parseInstant("2026-12-25 09:00", LA), LA)).toContain("9:00 AM PST");
  });

  it("rejects unknown zones and unreadable times", () => {
    expect(() => convertTime("2026-10-11 10:00", "Mars/Olympus", LA)).toThrow(/Unknown time zone/);
    expect(() => convertTime("next tuesday", "UTC", LA)).toThrow(/Couldn't read/);
  });
});

describe("calculator", () => {
  it("evaluates arithmetic exactly as written", () => {
    expect(calculate("(1299 * 0.85) / 12")).toBeCloseTo(92.0125);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-3 + 4 * 2")).toBe(5);
    expect(calculate("sqrt(16) + max(2, 7) - abs(-1)")).toBe(10);
    expect(calculate("1,250 × 4")).toBe(5000);
    expect(calculate("10 % 4")).toBe(2);
    expect(calculate("3 x 4")).toBe(12);
  });

  it("refuses anything that isn't math", () => {
    expect(() => calculate("alert(1)")).toThrow();
    expect(() => calculate("2 +")).toThrow();
    expect(() => calculate("1/0")).toThrow(/finite/);
  });
});

describe("units", () => {
  it("converts within a kind", () => {
    expect(convertUnits(10, "km", "mi")).toBeCloseTo(6.21371, 4);
    expect(convertUnits(212, "F", "C")).toBeCloseTo(100);
    expect(convertUnits(2, "cups", "ml")).toBeCloseTo(473.176, 2);
    expect(convertUnits(1, "GiB", "MB")).toBeCloseTo(1073.741824);
  });

  it("refuses mixed kinds", () => {
    expect(() => convertUnits(1, "kg", "m")).toThrow(/Can't convert/);
  });
});

describe("weather", () => {
  const fake = async (url: string) => {
    if (url.includes("geocoding")) {
      return {
        results: [
          { name: "Springfield", admin1: "Nebraska", country: "United States", country_code: "US", latitude: 41.4, longitude: -96.5 },
          { name: "Springfield", admin1: "California", country: "United States", country_code: "US", latitude: 37.55, longitude: -121.99 },
        ],
      };
    }
    expect(url).toContain("latitude=37.55");
    return {
      timezone: LA,
      current: { time: "2026-10-09T12:00", temperature_2m: 66.2, apparent_temperature: 67, relative_humidity_2m: 67, weather_code: 0, wind_speed_10m: 4, wind_gusts_10m: 9, precipitation: 0 },
      daily: {
        time: ["2026-10-09"], weather_code: [0], temperature_2m_max: [70.4], temperature_2m_min: [59.1], precipitation_probability_max: [0],
        precipitation_sum: [0], sunrise: ["2026-10-09T07:12"], sunset: ["2026-10-09T18:41"], uv_index_max: [5],
      },
    };
  };

  it("picks the right state and reports current conditions separately from the forecast", async () => {
    const text = await weather("Springfield, CA", 1, fake);
    expect(text).toContain("Springfield, California, United States");
    expect(text).toContain("observed Fri, Oct 9, 2026, 12:00 PM PDT");
    expect(text).toContain("Right now: 66°F (19°C), Clear");
    expect(text).toContain("Fri, Oct 9: Clear, high 70°F / low 59°F");
    expect(text).toContain("sunrise 7:12 AM, sunset 6:41 PM");
    expect(await weather("Springfield California", 1, fake)).toContain("California");
  });

  it("asks for a place when none is given", async () => {
    await expect(weather(" ", 1, fake)).rejects.toThrow(/No location/);
  });
});

describe("sports", () => {
  it("lists every F1 session in the user's time zone", async () => {
    const fake = async () => ({
      leagues: [{ name: "Formula 1" }],
      events: [
        {
          name: "Singapore Grand Prix",
          date: "2026-10-09T08:30Z",
          circuit: { fullName: "Marina Bay Street Circuit" },
          competitions: [
            { date: "2026-10-10T13:00Z", type: { abbreviation: "Qual" }, status: { type: { description: "Scheduled" } } },
            { date: "2026-10-11T12:00Z", type: { abbreviation: "Race" }, status: { type: { description: "Scheduled" } } },
          ],
        },
      ],
    });
    const text = await sports("f1", "scores", undefined, fake);
    expect(text).toContain("Qualifying: Sat, Oct 10, 2026, 6:00 AM");
    expect(text).toContain("Race: Sun, Oct 11, 2026, 5:00 AM");
  });

  it("rejects unknown leagues", async () => {
    await expect(sports("quidditch", "scores", undefined, async () => ({}))).rejects.toThrow(/Unknown league/);
  });
});

describe("wikipedia", () => {
  it("summarises the best match", async () => {
    const fake = async (url: string) =>
      url.includes("search")
        ? { pages: [{ key: "Marina_Bay_Street_Circuit", title: "Marina Bay Street Circuit" }] }
        : { title: "Marina Bay Street Circuit", description: "Street circuit in Singapore", extract: "A street circuit around Marina Bay.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Marina_Bay_Street_Circuit" } } };
    const text = await wikipedia("marina bay circuit", fake);
    expect(text).toContain("Street circuit in Singapore");
    expect(text).toContain("A street circuit around Marina Bay.");
  });
});
