import type { GuardResult } from "./types";

/**
 * L3 — grounding. Every figure Sarjy speaks must come from a tool result (or
 * from the user's own words). Deterministic and sub-millisecond, so it runs on
 * every sentence of every turn that could contain tool-derived data.
 */

// ---------- number extraction ----------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Words that mean "roughly" — the figure is allowed a wider tolerance. */
const HEDGES = /\b(about|around|roughly|approximately|nearly|almost|close to|near|up to|under|over|just (?:over|under)|mid|low|high|upper|lower)[- ]?$/i;

/** Units that mark a figure as a measurement (vs. a count like "three days"). */
const MEASURE_UNIT = /^\s*(?:[-\u2010-\u2013]|\s)?(degrees?|°|percent|%|per ?cent|km\/h|kph|kilomet(?:re|er)s?(?: per hour| an hour)?|mph|miles(?: per hour| an hour)?|mm|millimet(?:re|er)s?|celsius|fahrenheit|c\b|f\b)/i;
const COUNT_UNIT = /^\s*(?:[-\u2010-\u2013]|\s)?(days?|nights?|hours?|weeks?|minutes?|times?|things?|places?|cities|ways?)\b/i;

export type ExtractedNumber = {
  value: number;
  raw: string;
  hedged: boolean;
  kind: "measure" | "count" | "bare";
};

// Hyphens (incl. non-breaking U+2011 and en dash) and spaces between number words.
const SEP = "[\\s\\u2010\\u2011\\u2012\\u2013-]";
const WORD = `(?:${[...Object.keys(TENS), ...Object.keys(UNITS), "hundred", "minus", "negative"].join("|")})`;
const WORD_NUMBER = new RegExp(`\\b${WORD}(?:${SEP}+(?:and${SEP}+)?${WORD})*\\b`, "gi");
// "5,500" is five thousand five hundred (thousands separator), "21.5" is a decimal.
const DIGIT_NUMBER = /(?<![\w.,])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;

function parseWords(raw: string): number | null {
  const words = raw.toLowerCase().split(/[\s‐-–-]+/).filter((w) => w && w !== "and");
  let sign = 1;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w === "minus" || w === "negative") {
      if (seen) return null;
      sign = -1;
    } else if (w in UNITS) {
      current += UNITS[w];
      seen = true;
    } else if (w in TENS) {
      current += TENS[w];
      seen = true;
    } else if (w === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else return null;
  }
  total += current;
  return seen ? sign * total : null;
}

export function extractNumbers(sentence: string): ExtractedNumber[] {
  const found: (ExtractedNumber & { index: number; end: number })[] = [];

  for (const m of sentence.matchAll(WORD_NUMBER)) {
    const value = parseWords(m[0]);
    if (value === null) continue;
    found.push({ value, raw: m[0], index: m.index!, end: m.index! + m[0].length, hedged: false, kind: "bare" });
  }
  for (const m of sentence.matchAll(DIGIT_NUMBER)) {
    const value = Number(m[0].replace("−", "-").replace(/,/g, ""));
    if (Number.isFinite(value)) {
      found.push({ value, raw: m[0], index: m.index!, end: m.index! + m[0].length, hedged: false, kind: "bare" });
    }
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map((n) => {
      const before = sentence.slice(Math.max(0, n.index - 24), n.index);
      const after = sentence.slice(n.end, n.end + 30);
      const kind: ExtractedNumber["kind"] = MEASURE_UNIT.test(after) ? "measure" : COUNT_UNIT.test(after) ? "count" : "bare";
      return { value: n.value, raw: n.raw, hedged: HEDGES.test(before.trimEnd()), kind };
    })
    .filter((n) => {
      // "one" is usually a pronoun ("the one", "no one", "one moment") unless it has a unit.
      if (/^one$/i.test(n.raw) && n.kind !== "measure") return false;
      return true;
    });
}

// ---------- allowed values ----------

/** Every number present in the tool results, plus parts of any dates/times. */
export function groundingValues(toolResults: unknown[], userText: string): number[] {
  const values: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    else if (typeof v === "string") {
      const date = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
      if (date) date.slice(1).filter(Boolean).forEach((p) => values.push(Number(p)));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  toolResults.forEach(walk);
  // Numbers the user said themselves may be repeated back ("in 3 days", "under 20 degrees?").
  for (const n of extractNumbers(userText)) values.push(n.value);
  return values;
}

const TOLERANCE = 1; // rounding: model may say 29 for 28.6
const HEDGED_TOLERANCE = 3; // "around thirty" for 28

export function isGrounded(n: ExtractedNumber, allowed: number[]): boolean {
  // Small counts ("three days", "7 day forecast") are structure, not data.
  if (n.kind === "count" && Math.abs(n.value) <= 16) return true;
  const tol = n.hedged ? HEDGED_TOLERANCE : TOLERANCE;
  return allowed.some((a) => Math.abs(a - n.value) <= tol);
}

// ---------- the guard ----------

export type GroundingInput = {
  sentence: string;
  userText: string;
  /** Results of every tool call made so far this turn. */
  toolResults: unknown[];
};

/** True for sentences that state weather-like figures (temperature, %, wind, rain amounts). */
function hasMeasurements(nums: ExtractedNumber[]): boolean {
  return nums.some((n) => n.kind === "measure");
}

/** Weather talk — used to decide whether an untooled figure is a forecast claim or general knowledge. */
const STRONG_WEATHER =
  /\b(weather|forecast|rain(y|ing)?|sunny|snow(ing)?|wind(y)?|humid(ity)?|umbrella|cloud(y|s)?|storm|drizzle|showers?|high of|low of)\b/i;
/**
 * "Hot", "cold", "highs" are only weather talk about a place or time ("hot in Lahore",
 * "cold tomorrow"). "How hot is the surface of the sun?" is not (eval-found false positive).
 */
const WEAK_WEATHER = /\b(hot|cold|chilly|warm|temperatures?|highs?|lows?)\b/i;
const PLACE_OR_TIME = /\b(today|tonight|tomorrow|this (week|weekend|morning|afternoon|evening)|right now|outside|later|this time of year)\b|\bin [A-Z][a-z]+/;

export function isWeatherTalk(text: string): boolean {
  return STRONG_WEATHER.test(text) || (WEAK_WEATHER.test(text) && PLACE_OR_TIME.test(text));
}

export function checkGrounding({ sentence, userText, toolResults }: GroundingInput): GuardResult & { ungrounded: string[] } {
  const t0 = performance.now();
  const nums = extractNumbers(sentence);
  const done = (r: Omit<GuardResult, "layer" | "ms">, ungrounded: string[] = []) => ({
    layer: "L3_grounding" as const,
    ms: Math.round((performance.now() - t0) * 100) / 100,
    ungrounded,
    ...r,
  });

  if (nums.length === 0) return done({ verdict: "pass", reason: "no figures" });

  if (toolResults.length === 0) {
    // No tool was called, so any measurement is from the model's memory → unverifiable.
    const weatherTalk = isWeatherTalk(sentence) || isWeatherTalk(userText);
    return hasMeasurements(nums) && weatherTalk
      ? done({ verdict: "repair", reason: "stated weather figures without calling the weather tool" }, nums.map((n) => n.raw))
      : done({ verdict: "pass", reason: "figures are general knowledge, not live data" });
  }

  const allowed = groundingValues(toolResults, userText);
  const ungrounded = nums.filter((n) => !isGrounded(n, allowed)).map((n) => n.raw);
  if (ungrounded.length) {
    return done({ verdict: "repair", reason: `not in tool data: ${ungrounded.join(", ")}` }, ungrounded);
  }
  return done({ verdict: "pass", reason: `${nums.length} figure(s) match tool data` });
}
