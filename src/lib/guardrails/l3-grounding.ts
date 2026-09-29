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
const MEASURE_UNIT = /^\s*(?:[-\u2010-\u2013]|\s)?(degrees?|°|percent|%|per ?cent|km\/h|kph|kilomet(?:re|er)s?(?: per hour| an hour)?|mph|miles(?: per hour| an hour)?|mm|millimet(?:re|er)s?|celsius|fahrenheit|kelvin|kmh|grados?|degr[eé]s?|grad\b|por ?ciento|pour ?cent|c\b|f\b|k\b)/i;
const COUNT_UNIT = /^\s*(?:[-\u2010-\u2013]|\s)?(days?|nights?|hours?|weeks?|minutes?|times?|things?|places?|cities|ways?)\b/i;

export type ExtractedNumber = {
  value: number;
  raw: string;
  hedged: boolean;
  kind: "measure" | "count" | "bare";
  /** Allowed distance from a tool value, when the phrase itself is a range ("upper thirties"). */
  tolerance?: number;
};

// Hyphens (incl. non-breaking U+2011 and en dash) and spaces between number words.
const SEP = "[\\s\\u2010\\u2011\\u2012\\u2013-]";
const WORD = `(?:${[...Object.keys(TENS), ...Object.keys(UNITS), "hundred", "minus", "negative"].join("|")})`;
const WORD_NUMBER = new RegExp(`\\b${WORD}(?:${SEP}+(?:and${SEP}+)?${WORD})*\\b`, "gi");
// "5,500" is five thousand five hundred (thousands separator), "21.5" is a decimal.
// Units may be glued on ("46C", "300K", "20mph"): the red-team slipped "46C" past a
// lookahead that required a non-word character after the digits. Times like "5pm" are skipped.
const GLUED_UNIT = "(?:[CFK]|km\\/?h|kph|mph|mm|cm)\\b";
const DIGIT_NUMBER = new RegExp(`(?<![\\w.,])[-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:(?![\\w])|(?=${GLUED_UNIT}))`, "gi");

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

/**
 * Digits in other scripts → ASCII. Round 2 of the red-team got a Hindi reply with
 * Devanagari numerals ("८८ °F") that L3 never saw. Each is one UTF-16 unit, so
 * string positions are unchanged.
 */
const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0xff10];
export function toAsciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (c) => {
    const cp = c.codePointAt(0)!;
    const base = DIGIT_BLOCKS.find((b) => cp >= b && cp <= b + 9);
    return base === undefined ? c : String(cp - base);
  });
}

/** "upper thirties", "mid-twenties", "the teens": a band, grounded if a tool value falls inside it. */
const DECADES: Record<string, number> = { teens: 10, twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, nineties: 90 };
const DECADE = new RegExp(`\\b(?:(low|lower|early|mid|upper|high|late)${SEP}*)?(${Object.keys(DECADES).join("|")})\\b`, "gi");

function decadeBand(qualifier: string | undefined, decade: string): { value: number; tolerance: number } {
  const base = DECADES[decade.toLowerCase()];
  const q = qualifier?.toLowerCase();
  if (decade.toLowerCase() === "teens") return { value: 16, tolerance: 3 };
  if (!q) return { value: base + 5, tolerance: 5 };
  if (q === "mid") return { value: base + 5, tolerance: 2 };
  return ["low", "lower", "early"].includes(q) ? { value: base + 2, tolerance: 2 } : { value: base + 8, tolerance: 2 };
}

// ---------- Spanish / French number words (round 3: "cuarenta y seis grados") ----------

const ES: Record<string, number> = {
  cero: 0, uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
  ochenta: 80, noventa: 90, cien: 100, ciento: 100,
};
const FR: Record<string, number> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11,
  douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40,
  cinquante: 50, soixante: 60, cent: 100,
};
const MINUS = new Set(["menos", "moins"]);
const JOINERS = new Set(["y", "et"]);
/** Only parse these when the sentence is actually Spanish/French: "once" is 11 in Spanish. */
const ES_HINT = /\b(el|la|los|las|de|del|que|es|con|hoy|grados|temperatura|m[aá]xima|m[ií]nima|ser[aá])\b/gi;
const FR_HINT = /\b(le|la|les|des|du|est|avec|aujourd'?hui|degr[eé]s|temp[eé]rature|maximale|minimale|sera)\b/gi;

function fold(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parseRomance(tokens: string[], lex: Record<string, number>): number | null {
  let sign = 1;
  let total = 0;
  let seen = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (MINUS.has(t) && !seen) sign = -1;
    else if (JOINERS.has(t)) continue;
    else if (t in lex) {
      const v = lex[t];
      // French 80 = quatre-vingt(s); "cent" after a unit multiplies (deux cents).
      if ((t === "vingt" || t === "vingts") && tokens[i - 1] === "quatre") total += 80 - 4;
      else if ((t === "cent" || t === "ciento" || t === "cien") && total > 0 && total < 10) total *= 100;
      else total += v;
      seen = true;
    } else return null;
  }
  return seen ? sign * total : null;
}

function romanceNumbers(sentence: string): { value: number; raw: string; index: number; end: number }[] {
  const f = fold(sentence);
  const es = (f.match(ES_HINT) ?? []).length;
  const fr = (f.match(FR_HINT) ?? []).length;
  if (Math.max(es, fr) < 2) return [];
  const lex = es >= fr ? ES : FR;
  const vocab = [...Object.keys(lex), ...MINUS, ...JOINERS].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`\\b(?:${vocab})(?:[\\s-]+(?:${vocab}))*\\b`, "g");
  const out: { value: number; raw: string; index: number; end: number }[] = [];
  for (const m of f.matchAll(re)) {
    const tokens = m[0].split(/[\s-]+/);
    if (tokens.every((t) => JOINERS.has(t) || MINUS.has(t))) continue;
    const value = parseRomance(tokens, lex);
    if (value !== null) out.push({ value, raw: sentence.slice(m.index!, m.index! + m[0].length), index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Temperature words in scripts whose number words we don't parse: a figure is being stated, but we can't read it. */
export const OPAQUE_UNIT = /डिग्री|درجے|درجہ|درجة|度|градус/;

export function extractNumbers(input: string): ExtractedNumber[] {
  const sentence = toAsciiDigits(input);
  const found: (ExtractedNumber & { index: number; end: number })[] = [];

  for (const n of romanceNumbers(sentence)) found.push({ ...n, hedged: false, kind: "bare" });

  for (const m of sentence.matchAll(DECADE)) {
    const band = decadeBand(m[1], m[2]);
    found.push({ ...band, raw: m[0], index: m.index!, end: m.index! + m[0].length, hedged: true, kind: "measure" });
  }

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
      if (n.tolerance !== undefined) return { value: n.value, raw: n.raw, hedged: true, kind: n.kind, tolerance: n.tolerance };
      return { value: n.value, raw: n.raw, hedged: HEDGES.test(before.trimEnd()), kind };
    })
    .filter((n) => {
      // "one" is usually a pronoun ("the one", "no one", "one moment") unless it has a unit;
      // likewise the Spanish/French articles "un", "una", "une", "uno".
      if (/^(one|un|una|une|uno)$/i.test(n.raw) && n.kind !== "measure") return false;
      return true;
    });
}

// ---------- allowed values ----------

/** Every number present in the tool results, plus parts of any dates/times. */
export function groundingValues(toolResults: unknown[], userText: string): number[] {
  const values: number[] = [];
  const TEMPERATURE_KEYS = new Set(["temperature", "feelsLike", "high", "low"]);
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      values.push(v);
      // A correct °C↔°F conversion of a tool temperature is grounded; any other number is not.
      if (key && TEMPERATURE_KEYS.has(key)) values.push((v * 9) / 5 + 32, ((v - 32) * 5) / 9);
    }
    else if (typeof v === "string") {
      const date = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
      if (date) date.slice(1).filter(Boolean).forEach((p) => values.push(Number(p)));
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  toolResults.forEach((r) => walk(r));
  // Numbers the user said themselves may be repeated back ("in 3 days", "under 20 degrees?").
  for (const n of extractNumbers(userText)) values.push(n.value);
  return values;
}

const TOLERANCE = 1; // rounding: model may say 29 for 28.6
const HEDGED_TOLERANCE = 3; // "around thirty" for 28

export function isGrounded(n: ExtractedNumber, allowed: number[]): boolean {
  // Small counts ("three days", "7 day forecast") are structure, not data.
  if (n.kind === "count" && Math.abs(n.value) <= 16) return true;
  const tol = n.tolerance ?? (n.hedged ? HEDGED_TOLERANCE : TOLERANCE);
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

  if (nums.length === 0) {
    // A tool turn stating a temperature in words we can't parse can't be verified: repair.
    if (toolResults.length && OPAQUE_UNIT.test(sentence)) {
      return done({ verdict: "repair", reason: "states figures we can't verify (unparsed number words)" }, [sentence.slice(0, 40)]);
    }
    return done({ verdict: "pass", reason: "no figures" });
  }

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
