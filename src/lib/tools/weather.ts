import { z } from "zod";
import type { ToolSpec } from "@/lib/llm/types";
import { chaos, sleep } from "@/lib/reliability/context";
import { hedge } from "@/lib/reliability/hedge";
import { retry, TransientError } from "@/lib/reliability/retry";
import { TtlCache } from "@/lib/reliability/ttlCache";

/** Open-Meteo gives up to 16 days, but beyond 7 accuracy drops — we cap and say so. */
export const MAX_FORECAST_DAYS = 7;

export const weatherArgs = z.object({
  location: z.string().min(1).max(100),
  days: z.number().int().min(1).optional(),
  units: z.enum(["celsius", "fahrenheit"]).optional(),
});
export type WeatherArgs = z.infer<typeof weatherArgs>;

export const weatherToolSpec: ToolSpec = {
  type: "function",
  function: {
    name: "get_weather",
    description:
      "Get current conditions and a daily forecast (up to 7 days) for a named place. " +
      "Always call this for any weather question; never answer weather from memory. " +
      "Only call it with a place the user actually named; if they didn't name one, ask.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or place name, e.g. 'Lahore' or 'Paris, France'" },
        days: { type: "integer", description: "Number of forecast days needed, 1-7", minimum: 1 },
        units: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
};

export type Place = {
  name: string;
  region?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export type DailyForecast = {
  date: string; // YYYY-MM-DD in the place's timezone
  weekday: string;
  condition: string;
  high: number;
  low: number;
  precipChancePct: number | null;
  precipMm: number;
};

export type WeatherSource = "open-meteo" | "met.no";

export type WeatherOk = {
  ok: true;
  location: Place;
  alternatives: string[]; // other places with the same name, for disambiguation
  units: { temperature: "°C" | "°F"; wind: "km/h" | "mph"; precipitation: "mm" };
  current: {
    time: string;
    temperature: number;
    feelsLike: number | null;
    humidityPct: number;
    windSpeed: number;
    condition: string;
  };
  daily: DailyForecast[];
  source: WeatherSource;
  /** Set when every live source failed and this is a cached forecast. */
  stale?: { asOf: string; minutesOld: number };
};

export type WeatherError = {
  ok: false;
  error: "not_found" | "out_of_range" | "unavailable" | "invalid_args" | "location_unconfirmed";
  message: string;
  query?: string;
};

export type WeatherResult = WeatherOk | WeatherError;

// ---------- budgets & caches ----------

// Measured from a dev machine on 2026-09-29: Open-Meteo geocoding 0.9-2.3 s typical, 11 s
// worst; forecast 0.85-5.9 s; MET Norway 1.5-2.5 s. So we hedge instead of waiting out timeouts.
const GEOCODE_TIMEOUT_MS = 3500;
/** Start a duplicate geocoding request if the first hasn't answered by then. */
const GEOCODE_HEDGE_MS = 1000;
const OPEN_METEO_TIMEOUT_MS = 4500;
/** Start MET Norway in parallel if Open-Meteo hasn't answered by then (or fails sooner). */
const FORECAST_HEDGE_MS = 1500;
const MET_NO_TIMEOUT_MS = 4000;
/** Hard ceiling for the whole tool call, including retries and fallbacks. */
const TOOL_BUDGET_MS = 7000;

/** Place lookups never change: cache for a day. Also removes ~0.3-1 s from repeat queries. */
const geocodeCache = new TtlCache<Place[]>(500, 24 * 60 * 60_000);
/** Forecasts: fresh for 10 min; kept 3 h as a last resort when every source is down. */
const FRESH_MS = 10 * 60_000;
const forecastCache = new TtlCache<{ at: number; data: Omit<WeatherOk, "alternatives"> }>(500, 3 * 60 * 60_000);

/** For tests and evals: start from cold caches. */
export function resetWeatherCaches() {
  geocodeCache.clear();
  forecastCache.clear();
}

const MET_NO_USER_AGENT = process.env.METNO_USER_AGENT ?? "sarjy-voice-assistant/0.1 (demo)";

// ---------- entry point ----------

export async function getWeather(rawArgs: unknown, signal?: AbortSignal): Promise<WeatherResult> {
  const parsed = weatherArgs.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: "invalid_args", message: parsed.error.message };
  const { location, days = 3, units = "celsius" } = parsed.data;

  if (days > MAX_FORECAST_DAYS) {
    return {
      ok: false,
      error: "out_of_range",
      message: `Forecasts are only available up to ${MAX_FORECAST_DAYS} days ahead; ${days} days was requested.`,
      query: location,
    };
  }

  const deadline = Date.now() + TOOL_BUDGET_MS;
  const budget = AbortSignal.timeout(TOOL_BUDGET_MS);
  const sig = signal ? AbortSignal.any([signal, budget]) : budget;
  const imperial = units === "fahrenheit";

  let places: Place[];
  try {
    places = await geocode(location, sig);
  } catch (err) {
    return unavailable(location, `place lookup failed: ${(err as Error).message}`);
  }
  if (places.length === 0) {
    return { ok: false, error: "not_found", message: `No place called "${location}" was found.`, query: location };
  }
  const [place, ...rest] = places;
  const alternatives = rest.map(describePlace).slice(0, 3);

  const key = `${place.latitude},${place.longitude}|${days}|${units}`;
  const cached = forecastCache.get(key);
  // Injected weather faults skip the fresh cache so the fallback path actually runs.
  const faultInjected = chaos("weather_down") || chaos("weather_slow") || chaos("weather_all_down");
  if (cached && !faultInjected && Date.now() - cached.at < FRESH_MS) return { ...cached.data, alternatives };

  let failure: string;
  try {
    const { value: data } = await hedge(
      (s) => fetchOpenMeteo(place, days, imperial, s, deadline),
      (s) => fetchMetNo(place, days, imperial, s),
      { delayMs: FORECAST_HEDGE_MS, signal: sig },
    );
    forecastCache.set(key, { at: Date.now(), data });
    return { ...data, alternatives };
  } catch (err) {
    if (signal?.aborted) throw err;
    failure = (err as Error).message;
  }

  if (cached) {
    const minutesOld = Math.round((Date.now() - cached.at) / 60_000);
    return { ...cached.data, alternatives, stale: { asOf: new Date(cached.at).toISOString(), minutesOld } };
  }
  return unavailable(location, failure);
}

function unavailable(query: string, detail: string): WeatherError {
  return { ok: false, error: "unavailable", message: `The weather service is unavailable (${detail}).`, query };
}

// ---------- HTTP ----------

class TimeoutFailure extends TransientError {}

/**
 * Fetches JSON, classifying failures: network errors, 429 and 5xx are transient;
 * timeouts are transient but *not* retried by callers (slow ≠ flaky: fail over instead).
 */
async function fetchJson(
  url: string,
  opts: { timeoutMs: number; signal: AbortSignal; stall?: boolean; fail?: boolean; headers?: HeadersInit },
) {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const sig = AbortSignal.any([opts.signal, timeout]);
  try {
    if (opts.fail) throw new TransientError("simulated outage (chaos)");
    if (opts.stall) await sleep(opts.timeoutMs + 1000, sig);
    const res = await fetch(url, { signal: sig, headers: opts.headers });
    if (res.status === 429 || res.status >= 500) throw new TransientError(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof TransientError || err instanceof Error && err.message.startsWith("HTTP")) throw err;
    if (timeout.aborted) throw new TimeoutFailure(`timed out after ${opts.timeoutMs} ms`);
    if (opts.signal.aborted) throw err;
    throw new TransientError(`network error: ${(err as Error).message}`);
  }
}

/** Retry once on a fast transient failure; never on timeout. */
function retryFast<T>(fn: () => Promise<T>, signal: AbortSignal, deadline: number) {
  return retry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof TimeoutFailure) throw new Error(err.message); // non-retryable
        throw err;
      }
    },
    { attempts: 2, baseDelayMs: 150, deadline, signal },
  );
}

// ---------- geocoding (Open-Meteo) ----------

async function geocode(query: string, signal: AbortSignal): Promise<Place[]> {
  const cacheKey = query.trim().toLowerCase();
  const hit = geocodeCache.get(cacheKey);
  if (hit) return hit;

  const url = `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({
    name: query.split(",")[0].trim(),
    count: "5",
    language: "en",
    format: "json",
  })}`;
  const lookup = (s: AbortSignal) => fetchJson(url, { timeoutMs: GEOCODE_TIMEOUT_MS, signal: s, fail: chaos("weather_all_down") });
  // No second geocoder, so hedge with a duplicate request: cuts the slow tail, free API, no quota.
  const { value: geo } = await hedge(lookup, lookup, { delayMs: GEOCODE_HEDGE_MS, signal });
  const places = pickPlaces(geo, query);
  geocodeCache.set(cacheKey, places);
  return places;
}

type GeoResult = {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
};

/**
 * Open-Meteo matches on the name only, so "Paris, Texas" would return Paris, France first.
 * If the user gave a qualifier, prefer results whose region/country contain it.
 */
export function pickPlaces(geo: { results?: GeoResult[] }, query: string): Place[] {
  const results = geo.results ?? [];
  const qualifier = query.split(",").slice(1).join(",").trim().toLowerCase();
  const scored = results
    .map((r, i) => {
      const hay = `${r.admin1 ?? ""} ${r.country ?? ""}`.toLowerCase();
      const qualifies = qualifier ? hay.includes(qualifier) : false;
      return { r, rank: (qualifies ? 0 : 1) * 100 + i };
    })
    .sort((a, b) => a.rank - b.rank);
  if (qualifier && !scored.some((s) => s.rank < 100)) return [];
  return scored.map(({ r }) => ({
    name: r.name,
    region: r.admin1,
    country: r.country,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? "UTC",
  }));
}

export function describePlace(p: Place): string {
  return [p.name, p.region, p.country].filter(Boolean).join(", ");
}

// ---------- primary: Open-Meteo ----------

async function fetchOpenMeteo(place: Place, days: number, imperial: boolean, signal: AbortSignal, deadline: number) {
  const url = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    timezone: "auto",
    forecast_days: String(days),
    temperature_unit: imperial ? "fahrenheit" : "celsius",
    wind_speed_unit: imperial ? "mph" : "kmh",
  })}`;
  const forecast = await retryFast(
    () =>
      fetchJson(url, {
        timeoutMs: OPEN_METEO_TIMEOUT_MS,
        signal,
        fail: chaos("weather_down") || chaos("weather_all_down"),
        stall: chaos("weather_slow"),
      }),
    signal,
    deadline,
  );
  return normalizeForecast(forecast, place, imperial);
}

type OpenMeteoForecast = {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: number[];
  };
};

export function normalizeForecast(f: OpenMeteoForecast, place: Place, imperial: boolean): Omit<WeatherOk, "alternatives"> {
  const round = (n: number) => Math.round(n);
  return {
    ok: true,
    location: place,
    units: unitsFor(imperial),
    current: {
      time: f.current.time,
      temperature: round(f.current.temperature_2m),
      feelsLike: round(f.current.apparent_temperature),
      humidityPct: round(f.current.relative_humidity_2m),
      windSpeed: round(f.current.wind_speed_10m),
      condition: describeWeatherCode(f.current.weather_code),
    },
    daily: f.daily.time.map((date, i) => ({
      date,
      weekday: weekdayOf(date),
      condition: describeWeatherCode(f.daily.weather_code[i]),
      high: round(f.daily.temperature_2m_max[i]),
      low: round(f.daily.temperature_2m_min[i]),
      precipChancePct: f.daily.precipitation_probability_max[i],
      precipMm: f.daily.precipitation_sum[i],
    })),
    source: "open-meteo",
  };
}

// ---------- fallback: MET Norway ----------

type MetNoEntry = {
  time: string;
  data: {
    instant: { details: { air_temperature: number; relative_humidity: number; wind_speed: number } };
    next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
    next_6_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
  };
};

async function fetchMetNo(place: Place, days: number, imperial: boolean, signal: AbortSignal) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${place.latitude.toFixed(4)}&lon=${place.longitude.toFixed(4)}`;
  const body = await fetchJson(url, {
    timeoutMs: MET_NO_TIMEOUT_MS,
    signal,
    fail: chaos("weather_all_down"),
    headers: { "User-Agent": MET_NO_USER_AGENT },
  });
  return normalizeMetNo(body.properties.timeseries as MetNoEntry[], place, days, imperial);
}

export function normalizeMetNo(series: MetNoEntry[], place: Place, days: number, imperial: boolean): Omit<WeatherOk, "alternatives"> {
  const toTemp = (c: number) => Math.round(imperial ? (c * 9) / 5 + 32 : c);
  const toWind = (ms: number) => Math.round(imperial ? ms * 2.23694 : ms * 3.6);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: place.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: place.timezone, hour: "2-digit", hourCycle: "h23" });

  const byDate = new Map<string, MetNoEntry[]>();
  for (const e of series) {
    const d = localDate.format(new Date(e.time));
    byDate.set(d, [...(byDate.get(d) ?? []), e]);
  }

  const first = series[0];
  const daily = [...byDate.entries()].slice(0, days).map(([date, entries]) => {
    const temps = entries.map((e) => e.data.instant.details.air_temperature);
    // Hourly steps carry next_1_hours; later 6-hourly steps only next_6_hours.
    const precip = entries.reduce(
      (sum, e) => sum + (e.data.next_1_hours?.details.precipitation_amount ?? e.data.next_6_hours?.details.precipitation_amount ?? 0),
      0,
    );
    const midday =
      entries.find((e) => Number(localHour.format(new Date(e.time))) >= 12 && e.data.next_6_hours) ?? entries[0];
    const symbol = midday.data.next_6_hours?.summary.symbol_code ?? midday.data.next_1_hours?.summary.symbol_code ?? "";
    return {
      date,
      weekday: weekdayOf(date),
      condition: describeMetNoSymbol(symbol),
      high: toTemp(Math.max(...temps)),
      low: toTemp(Math.min(...temps)),
      precipChancePct: null, // not provided by MET Norway's compact product
      precipMm: Math.round(precip * 10) / 10,
    };
  });

  return {
    ok: true,
    location: place,
    units: unitsFor(imperial),
    current: {
      time: first.time,
      temperature: toTemp(first.data.instant.details.air_temperature),
      feelsLike: null,
      humidityPct: Math.round(first.data.instant.details.relative_humidity),
      windSpeed: toWind(first.data.instant.details.wind_speed),
      condition: describeMetNoSymbol(first.data.next_1_hours?.summary.symbol_code ?? ""),
    },
    daily,
    source: "met.no",
  };
}

export function describeMetNoSymbol(code: string): string {
  const c = code.replace(/_(day|night|polartwilight)$/, "");
  if (c.includes("thunder")) return "thunderstorm";
  const table: Record<string, string> = {
    clearsky: "clear sky",
    fair: "mainly clear",
    partlycloudy: "partly cloudy",
    cloudy: "overcast",
    fog: "fog",
    lightrain: "light rain",
    rain: "rain",
    heavyrain: "heavy rain",
    lightrainshowers: "light showers",
    rainshowers: "showers",
    heavyrainshowers: "heavy showers",
    lightsnow: "light snow",
    snow: "snow",
    heavysnow: "heavy snow",
    lightsnowshowers: "light snow showers",
    snowshowers: "snow showers",
    lightsleet: "light sleet",
    sleet: "sleet",
    sleetshowers: "sleet showers",
  };
  return table[c] ?? "unknown conditions";
}

// ---------- shared helpers ----------

function unitsFor(imperial: boolean): WeatherOk["units"] {
  return { temperature: imperial ? "°F" : "°C", wind: imperial ? "mph" : "km/h", precipitation: "mm" };
}

function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/** WMO weather interpretation codes, as documented by Open-Meteo. */
const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

export function describeWeatherCode(code: number): string {
  return WMO[code] ?? "unknown conditions";
}

// ---------- grounded fallback wording ----------

/**
 * A spoken summary built only from the tool result. Used when L3 rejects the
 * model's wording: guaranteed grounded, and instant (no second LLM call).
 */
export function summarizeWeather(result: WeatherResult, userText: string): string {
  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        return `I couldn't find a place called ${result.query ?? "that"}. Could you say it another way?`;
      case "out_of_range":
        return `I can only see forecasts up to ${MAX_FORECAST_DAYS} days ahead.`;
      case "location_unconfirmed":
      case "invalid_args":
        return "Which city should I check the weather for?";
      default:
        return "I can't reach the weather service right now, so I won't guess. Could you try me again in a minute?";
    }
  }

  const deg = result.units.temperature === "°F" ? "degrees Fahrenheit" : "degrees";
  const where = describePlace(result.location);
  const text = userText.toLowerCase();
  let idx = /\btomorrow\b/.test(text) ? 1 : 0;
  const named = result.daily.findIndex((d) => text.includes(d.weekday.toLowerCase()));
  if (named >= 0) idx = named;
  const day = result.daily[Math.min(idx, result.daily.length - 1)];
  const label = idx === 0 ? "Today" : idx === 1 ? "Tomorrow" : day.weekday;
  const rain = day.precipChancePct != null ? `, ${day.precipChancePct} percent chance of rain` : "";

  const parts = [
    `Here are the exact figures for ${where}${result.stale ? `, from ${result.stale.minutesOld} minutes ago` : ""}.`,
    idx === 0 ? `Right now it's ${result.current.temperature} ${deg} and ${result.current.condition}.` : "",
    `${label}: ${day.condition}, high ${day.high}, low ${day.low}${rain}.`,
  ];
  return parts.filter(Boolean).join(" ");
}
