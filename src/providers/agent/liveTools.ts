/**
 * Live-data and exact-answer tools every agent gets: weather, sports, Wikipedia (free services,
 * no keys), plus time-zone conversion, a calculator and unit conversion that run locally — the
 * things models most often get wrong when they guess. Times are always shown in the user's zone.
 */

export type FetchJson = (url: string) => Promise<unknown>;

export const userTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ── Time zones ────────────────────────────────────────────────────────────────

const ZONE_ALIASES: Record<string, string> = {
  utc: "UTC", gmt: "UTC", z: "UTC",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  bst: "Europe/London", uk: "Europe/London", cet: "Europe/Paris", cest: "Europe/Paris",
  ist: "Asia/Kolkata", pkt: "Asia/Karachi", sgt: "Asia/Singapore", jst: "Asia/Tokyo", aest: "Australia/Sydney",
  local: "", me: "", mine: "",
};

/** IANA zone for a name like "PT", "Asia/Singapore" or "" (the user's own zone). */
export function resolveZone(name: string | undefined): string {
  const raw = (name ?? "").trim();
  const alias = ZONE_ALIASES[raw.toLowerCase()];
  const zone = alias === undefined ? raw : alias;
  if (!zone) return userTimeZone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`Unknown time zone "${raw}". Use an IANA name such as America/Los_Angeles or Asia/Singapore.`);
  }
}

/** Offset of `zone` from UTC at `instant`, in minutes. */
function zoneOffsetMinutes(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instant) / 60_000);
}

/** Instant for a date-time string: with Z/offset as given, otherwise as wall time in `zone`. */
export function parseInstant(text: string, zone: string, now = Date.now()): number {
  const value = text.trim();
  if (!value || /^now$/i.test(value)) return now;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(value);
  if (!m) throw new Error(`Couldn't read "${text}". Use YYYY-MM-DD HH:MM (24-hour) or an ISO time.`);
  let hour = Number(m[4] ?? 0);
  if (m[7]) hour = (hour % 12) + (m[7].toLowerCase() === "pm" ? 12 : 0);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], hour, Number(m[5] ?? 0), Number(m[6] ?? 0));
  // Two passes settle the offset correctly around daylight-saving changes.
  let instant = wall - zoneOffsetMinutes(wall, zone) * 60_000;
  instant = wall - zoneOffsetMinutes(instant, zone) * 60_000;
  return instant;
}

/** e.g. "Sun, Oct 11, 2026, 5:00 AM PDT". */
export function formatInstant(instant: number, zone = userTimeZone()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(instant));
}

export function convertTime(time: string, from?: string, to?: string, now = Date.now()): string {
  const fromZone = resolveZone(from || "UTC");
  const toZone = resolveZone(to);
  const instant = parseInstant(time, fromZone, now);
  return `${formatInstant(instant, fromZone)} (${fromZone}) = ${formatInstant(instant, toZone)} (${toZone})`;
}

// ── Calculator ────────────────────────────────────────────────────────────────

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  log: Math.log10, log10: Math.log10, log2: Math.log2, ln: Math.log, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluates arithmetic exactly as written (no eval): + − × ÷ % ^, parentheses, functions. */
export function calculate(expression: string): number {
  const src = expression.replace(/×/g, "*").replace(/(?<=[\d)]\s*)x(?=\s*[\d(.])/gi, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,(?=\d{3}\b)/g, "");
  let pos = 0;
  const peek = () => src.slice(pos).match(/^\s*/)![0].length + pos;
  const at = (ch: string) => {
    pos = peek();
    if (src[pos] === ch) {
      pos++;
      return true;
    }
    return false;
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      if (at("+")) v += term();
      else if (at("-")) v -= term();
      else return v;
    }
  };
  const term = (): number => {
    let v = power();
    for (;;) {
      if (at("*")) v *= power();
      else if (at("/")) v /= power();
      else if (at("%")) v %= power();
      else return v;
    }
  };
  const power = (): number => {
    const base = unary();
    return at("^") ? Math.pow(base, power()) : base;
  };
  const unary = (): number => (at("-") ? -unary() : at("+") ? unary() : atom());
  const atom = (): number => {
    pos = peek();
    if (at("(")) {
      const v = expr();
      if (!at(")")) throw new Error("missing )");
      return v;
    }
    const num = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(pos));
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    const name = /^[a-z_][a-z0-9_]*/i.exec(src.slice(pos));
    if (name) {
      pos += name[0].length;
      const key = name[0].toLowerCase();
      if (key in CONSTANTS) return CONSTANTS[key];
      const fn = FUNCTIONS[key];
      if (!fn || !at("(")) throw new Error(`unknown name "${name[0]}"`);
      const args = [expr()];
      while (at(",")) args.push(expr());
      if (!at(")")) throw new Error("missing )");
      return fn(...args);
    }
    throw new Error(`unexpected "${src.slice(pos, pos + 8) || "end"}"`);
  };
  const result = expr();
  if (peek() < src.length) throw new Error(`unexpected "${src.slice(peek(), peek() + 8)}"`);
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}

export const formatNumber = (n: number) => (Number.isInteger(n) ? n.toString() : Number(n.toPrecision(12)).toString());

// ── Units ─────────────────────────────────────────────────────────────────────

const UNITS: Record<string, [kind: string, toBase: number]> = {};
const unit = (kind: string, factor: number, ...names: string[]) => names.forEach((n) => (UNITS[n] = [kind, factor]));
unit("length", 0.001, "mm", "millimeter", "millimeters");
unit("length", 0.01, "cm", "centimeter", "centimeters");
unit("length", 1, "m", "meter", "meters", "metre", "metres");
unit("length", 1000, "km", "kilometer", "kilometers");
unit("length", 0.0254, "in", "inch", "inches");
unit("length", 0.3048, "ft", "foot", "feet");
unit("length", 0.9144, "yd", "yard", "yards");
unit("length", 1609.344, "mi", "mile", "miles");
unit("length", 1852, "nmi", "nautical mile", "nautical miles");
unit("mass", 0.001, "g", "gram", "grams");
unit("mass", 0.000001, "mg", "milligram", "milligrams");
unit("mass", 1, "kg", "kilogram", "kilograms");
unit("mass", 0.028349523125, "oz", "ounce", "ounces");
unit("mass", 0.45359237, "lb", "lbs", "pound", "pounds");
unit("mass", 6.35029318, "st", "stone");
unit("mass", 907.18474, "ton", "tons", "short ton");
unit("mass", 1000, "t", "tonne", "tonnes", "metric ton");
unit("volume", 0.001, "ml", "milliliter", "milliliters");
unit("volume", 1, "l", "liter", "liters", "litre", "litres");
unit("volume", 0.00492892159375, "tsp", "teaspoon", "teaspoons");
unit("volume", 0.01478676478125, "tbsp", "tablespoon", "tablespoons");
unit("volume", 0.0295735295625, "floz", "fl oz", "fluid ounce", "fluid ounces");
unit("volume", 0.2365882365, "cup", "cups");
unit("volume", 0.473176473, "pt", "pint", "pints");
unit("volume", 0.946352946, "qt", "quart", "quarts");
unit("volume", 3.785411784, "gal", "gallon", "gallons");
unit("speed", 1, "m/s", "mps");
unit("speed", 1 / 3.6, "km/h", "kph", "kmh");
unit("speed", 0.44704, "mph");
unit("speed", 0.514444, "knot", "knots", "kn");
unit("area", 1, "m2", "sq m", "square meter", "square meters");
unit("area", 1e6, "km2", "sq km", "square kilometer", "square kilometers");
unit("area", 0.09290304, "ft2", "sq ft", "square foot", "square feet");
unit("area", 4046.8564224, "acre", "acres");
unit("area", 10_000, "ha", "hectare", "hectares");
unit("data", 1, "b", "byte", "bytes");
unit("data", 1e3, "kb", "kilobyte", "kilobytes");
unit("data", 1e6, "mb", "megabyte", "megabytes");
unit("data", 1e9, "gb", "gigabyte", "gigabytes");
unit("data", 1e12, "tb", "terabyte", "terabytes");
unit("data", 1024, "kib");
unit("data", 1024 ** 2, "mib");
unit("data", 1024 ** 3, "gib");
unit("data", 1024 ** 4, "tib");
unit("time", 1, "s", "sec", "second", "seconds");
unit("time", 60, "min", "minute", "minutes");
unit("time", 3600, "h", "hr", "hour", "hours");
unit("time", 86_400, "day", "days");
unit("time", 604_800, "week", "weeks");
unit("time", 31_557_600, "year", "years");

const TEMPERATURES = new Set(["c", "°c", "celsius", "f", "°f", "fahrenheit", "k", "kelvin"]);
const tempKey = (u: string) => u.replace("°", "")[0];

export function convertUnits(value: number, from: string, to: string): number {
  const a = from.trim().toLowerCase();
  const b = to.trim().toLowerCase();
  if (TEMPERATURES.has(a) && TEMPERATURES.has(b)) {
    const toC = { c: (v: number) => v, f: (v: number) => ((v - 32) * 5) / 9, k: (v: number) => v - 273.15 }[tempKey(a)]!;
    const fromC = { c: (v: number) => v, f: (v: number) => (v * 9) / 5 + 32, k: (v: number) => v + 273.15 }[tempKey(b)]!;
    return fromC(toC(value));
  }
  const ua = UNITS[a] ?? UNITS[a.replace(/s$/, "")];
  const ub = UNITS[b] ?? UNITS[b.replace(/s$/, "")];
  if (!ua) throw new Error(`Unknown unit "${from}".`);
  if (!ub) throw new Error(`Unknown unit "${to}".`);
  if (ua[0] !== ub[0]) throw new Error(`Can't convert ${ua[0]} (${from}) to ${ub[0]} (${to}).`);
  return (value * ua[1]) / ub[1];
}

// ── Weather (Open-Meteo) ──────────────────────────────────────────────────────

const WEATHER_CODES: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

interface Place {
  name: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
}

/** Finds a place; "Springfield, CA" or "Springfield California" prefers the matching state or country. */
async function geocode(location: string, fetchJson: FetchJson): Promise<Place> {
  const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(location);
  if (coords) return { name: location.trim(), latitude: +coords[1], longitude: +coords[2] };
  const [city, ...qualifiers] = location.split(",").map((s) => s.trim()).filter(Boolean);
  const search = async (name: string) =>
    ((await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`)) as { results?: Place[] })
      .results ?? [];
  const fits = (p: Place, hint: string) =>
    [p.admin1, p.country, p.country_code, STATE_CODES[p.admin1 ?? ""]]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase())
      .some((v) => v === hint || (v.length > 2 && hint.includes(v)));
  // "Springfield, CA" names its state; "Springfield California" may too, so try each split point.
  const words = city.split(/\s+/);
  const tries: [string, string][] = qualifiers.length
    ? [[city, qualifiers.join(" ").toLowerCase()]]
    : words.slice(1).map((_, i) => [words.slice(0, words.length - 1 - i).join(" "), words.slice(words.length - 1 - i).join(" ").toLowerCase()]);
  for (const [name, hint] of tries) {
    const match = (await search(name)).find((p) => fits(p, hint));
    if (match) return match;
  }
  const places = await search(city);
  if (places.length) return places[0];
  throw new Error(`Couldn't find a place called "${location}".`);
}

const STATE_CODES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

export async function weather(location: string, days: number, fetchJson: FetchJson): Promise<string> {
  if (!location.trim()) throw new Error("No location given. Use the user's saved location, or ask them where.");
  const place = await geocode(location, fetchJson);
  const span = Math.min(Math.max(Math.round(days) || 3, 1), 14);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max" +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=${span}`;
  const data = (await fetchJson(url)) as {
    timezone: string;
    current: Record<string, number | string>;
    daily: Record<string, (number | string)[]>;
  };
  const c = data.current;
  const toC = (f: number) => Math.round(((f - 32) * 5) / 9);
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const observed = formatInstant(parseInstant(String(c.time), data.timezone), data.timezone);
  const lines = [
    `Weather for ${where} (live data from Open-Meteo, observed ${observed})`,
    `Right now: ${Math.round(+c.temperature_2m)}°F (${toC(+c.temperature_2m)}°C), ${WEATHER_CODES[+c.weather_code] ?? "—"}, feels like ${Math.round(+c.apparent_temperature)}°F, humidity ${c.relative_humidity_2m}%, wind ${Math.round(+c.wind_speed_10m)} mph (gusts ${Math.round(+c.wind_gusts_10m)} mph), precipitation ${c.precipitation} in`,
    "Forecast:",
  ];
  const d = data.daily;
  for (let i = 0; i < d.time.length; i++) {
    const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${d.time[i]}T12:00:00Z`));
    const time = (v: string | number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(`${v}:00Z`));
    lines.push(
      `- ${date}: ${WEATHER_CODES[+d.weather_code[i]] ?? "—"}, high ${Math.round(+d.temperature_2m_max[i])}°F / low ${Math.round(+d.temperature_2m_min[i])}°F, ` +
        `rain chance ${d.precipitation_probability_max[i] ?? 0}% (${d.precipitation_sum[i]} in), UV ${d.uv_index_max[i]}, sunrise ${time(d.sunrise[i])}, sunset ${time(d.sunset[i])} (local)`,
    );
  }
  return lines.join("\n");
}

// ── Sports (ESPN, Jolpica for F1 standings) ───────────────────────────────────

const LEAGUES: Record<string, string> = {
  nfl: "football/nfl", "college-football": "football/college-football", ncaaf: "football/college-football",
  nba: "basketball/nba", wnba: "basketball/wnba", ncaab: "basketball/mens-college-basketball",
  mlb: "baseball/mlb", nhl: "hockey/nhl", mls: "soccer/usa.1",
  "premier-league": "soccer/eng.1", epl: "soccer/eng.1", "la-liga": "soccer/esp.1", bundesliga: "soccer/ger.1",
  "serie-a": "soccer/ita.1", "ligue-1": "soccer/fra.1", "champions-league": "soccer/uefa.champions",
  f1: "racing/f1", "formula-1": "racing/f1", nascar: "racing/nascar-premier", indycar: "racing/irl",
  ufc: "mma/ufc", pga: "golf/pga", atp: "tennis/atp", wta: "tennis/wta",
};

export const SPORTS_LEAGUES = Object.keys(LEAGUES);

interface EspnCompetitor {
  homeAway?: string;
  score?: string;
  winner?: boolean;
  team?: { displayName?: string };
  athlete?: { displayName?: string };
}
interface EspnStatus {
  type?: { state?: "pre" | "in" | "post"; description?: string; detail?: string };
}
interface EspnCompetition {
  date: string;
  type?: { abbreviation?: string };
  status?: EspnStatus;
  competitors?: EspnCompetitor[];
  venue?: { fullName?: string };
}
interface EspnEvent {
  name: string;
  date: string;
  status?: EspnStatus;
  competitions?: EspnCompetition[];
  circuit?: { fullName?: string };
}

const SESSION_NAMES: Record<string, string> = { FP1: "Practice 1", FP2: "Practice 2", FP3: "Practice 3", SS: "Sprint Qualifying", SR: "Sprint", Qual: "Qualifying", Race: "Race" };

export async function sports(league: string, kind: string, date: string | undefined, fetchJson: FetchJson): Promise<string> {
  const key = league.trim().toLowerCase().replace(/\s+/g, "-");
  const path = LEAGUES[key];
  if (!path) throw new Error(`Unknown league "${league}". Known: ${SPORTS_LEAGUES.join(", ")}. For anything else use web_search.`);
  const zone = userTimeZone();
  if (kind === "standings") {
    if (path === "racing/f1") {
      const data = (await fetchJson("https://api.jolpi.ca/ergast/f1/current/driverStandings.json")) as {
        MRData: { StandingsTable: { StandingsLists: { season: string; round: string; DriverStandings: { position: string; points: string; Driver: { givenName: string; familyName: string }; Constructors: { name: string }[] }[] }[] } };
      };
      const list = data.MRData.StandingsTable.StandingsLists[0];
      if (!list) return "No standings published yet.";
      return [`F1 ${list.season} driver standings after round ${list.round} (Jolpica F1 data):`, ...list.DriverStandings.slice(0, 20).map((d) => `${d.position}. ${d.Driver.givenName} ${d.Driver.familyName} (${d.Constructors[0]?.name ?? "—"}) — ${d.points} pts`)].join("\n");
    }
    const data = (await fetchJson(`https://site.api.espn.com/apis/v2/sports/${path}/standings`)) as {
      children?: { name: string; standings: { entries: { team: { displayName: string }; stats: { name: string; displayValue: string }[] }[] } }[];
    };
    const groups = data.children ?? [];
    if (!groups.length) return "No standings available for this league right now.";
    const pick = (stats: { name: string; displayValue: string }[], names: string[]) =>
      names.map((n) => stats.find((s) => s.name === n)).filter(Boolean).map((s) => `${s!.name} ${s!.displayValue}`).join(", ");
    return groups
      .map((g) => [`${g.name}:`, ...g.standings.entries.map((e, i) => `${i + 1}. ${e.team.displayName} — ${pick(e.stats, ["wins", "losses", "ties", "points", "winPercent", "gamesBehind"])}`)].join("\n"))
      .join("\n\n");
  }
  const dates = date ? `?dates=${date.replace(/-/g, "")}` : "";
  const data = (await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard${dates}`)) as { events?: EspnEvent[]; leagues?: { name?: string }[] };
  const events = data.events ?? [];
  const leagueName = data.leagues?.[0]?.name ?? league.toUpperCase();
  if (!events.length) return `No ${leagueName} events found${date ? ` on ${date}` : " right now"}.`;
  const at = (iso: string) => formatInstant(Date.parse(iso), zone);
  const lines = [`${leagueName} — ESPN data, all times in ${zone}:`];
  for (const event of events.slice(0, 30)) {
    const comps = event.competitions ?? [];
    if (path.startsWith("racing/") && comps.length > 1) {
      lines.push(`${event.name}${event.circuit?.fullName ? ` (${event.circuit.fullName})` : ""}:`);
      for (const c of comps) {
        const label = SESSION_NAMES[c.type?.abbreviation ?? ""] ?? c.type?.abbreviation ?? "Session";
        const winner = c.competitors?.find((p) => p.winner)?.athlete?.displayName;
        lines.push(`  - ${label}: ${at(c.date)} — ${c.status?.type?.description ?? ""}${winner ? `, won by ${winner}` : ""}`);
      }
      continue;
    }
    const c = comps[0];
    const state = c?.status?.type ?? event.status?.type;
    // Upcoming games: ESPN's detail repeats the start time in Eastern time, and scores are 0–0.
    const upcoming = state?.state === "pre";
    const status = upcoming ? "Scheduled" : (state?.detail ?? state?.description ?? "");
    const sides = (c?.competitors ?? [])
      .map((p) => `${p.team?.displayName ?? p.athlete?.displayName ?? "?"}${p.score !== undefined && !upcoming ? ` ${p.score}` : ""}`)
      .join(" vs ");
    lines.push(`- ${event.name}: ${at(event.date)} — ${status}${sides ? ` · ${sides}` : ""}${c?.venue?.fullName ? ` · ${c.venue.fullName}` : ""}`);
  }
  return lines.join("\n");
}

// ── Wikipedia ─────────────────────────────────────────────────────────────────

export async function wikipedia(query: string, fetchJson: FetchJson): Promise<string> {
  const search = (await fetchJson(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=3`)) as {
    pages?: { key: string; title: string; description?: string }[];
  };
  const pages = search.pages ?? [];
  if (!pages.length) return `No Wikipedia article found for "${query}".`;
  const summary = (await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pages[0].key)}`)) as {
    title: string;
    description?: string;
    extract?: string;
    timestamp?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  const others = pages.slice(1).map((p) => `${p.title}${p.description ? ` (${p.description})` : ""}`);
  return [
    `${summary.title}${summary.description ? ` — ${summary.description}` : ""}`,
    summary.content_urls?.desktop?.page ?? "",
    summary.timestamp ? `Article last edited ${summary.timestamp.slice(0, 10)}` : "",
    "",
    summary.extract ?? "",
    others.length ? `\nOther matches: ${others.join("; ")}` : "",
  ]
    .filter((l, i) => l || i === 3)
    .join("\n");
}
