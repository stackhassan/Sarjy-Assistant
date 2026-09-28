import { z } from "zod";
import type { ToolSpec } from "@/lib/llm/types";

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
      "Always call this for any weather question; never answer weather from memory.",
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

export type WeatherResult =
  | {
      ok: true;
      location: Place;
      alternatives: string[]; // other places with the same name, for disambiguation
      units: { temperature: "°C" | "°F"; wind: "km/h" | "mph"; precipitation: "mm" };
      current: {
        time: string;
        temperature: number;
        feelsLike: number;
        humidityPct: number;
        windSpeed: number;
        condition: string;
      };
      daily: DailyForecast[];
    }
  | { ok: false; error: "not_found" | "out_of_range" | "unavailable" | "invalid_args"; message: string };

const TIMEOUT_MS = 4000;

export async function getWeather(rawArgs: unknown, signal?: AbortSignal): Promise<WeatherResult> {
  const parsed = weatherArgs.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: "invalid_args", message: parsed.error.message };
  const { location, days = 3, units = "celsius" } = parsed.data;

  if (days > MAX_FORECAST_DAYS) {
    return {
      ok: false,
      error: "out_of_range",
      message: `Forecasts are only available up to ${MAX_FORECAST_DAYS} days ahead; ${days} days was requested.`,
    };
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({
        name: location.split(",")[0].trim(),
        count: "5",
        language: "en",
        format: "json",
      })}`,
      sig,
    );
    const matches = pickPlaces(geo, location);
    if (matches.length === 0) {
      return { ok: false, error: "not_found", message: `No place called "${location}" was found.` };
    }
    const [place, ...rest] = matches;

    const imperial = units === "fahrenheit";
    const forecast = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
        timezone: "auto",
        forecast_days: String(days),
        temperature_unit: imperial ? "fahrenheit" : "celsius",
        wind_speed_unit: imperial ? "mph" : "kmh",
      })}`,
      sig,
    );

    return normalizeForecast(forecast, place, rest.map(describePlace), imperial);
  } catch (err) {
    const timedOut = timeout.aborted;
    return {
      ok: false,
      error: "unavailable",
      message: timedOut ? "The weather service timed out." : `The weather service failed: ${(err as Error).message}`,
    };
  }
}

async function fetchJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

export function normalizeForecast(
  f: OpenMeteoForecast,
  place: Place,
  alternatives: string[],
  imperial: boolean,
): WeatherResult {
  const round = (n: number) => Math.round(n);
  return {
    ok: true,
    location: place,
    alternatives: alternatives.slice(0, 3),
    units: { temperature: imperial ? "°F" : "°C", wind: imperial ? "mph" : "km/h", precipitation: "mm" },
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
      weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
      condition: describeWeatherCode(f.daily.weather_code[i]),
      high: round(f.daily.temperature_2m_max[i]),
      low: round(f.daily.temperature_2m_min[i]),
      precipChancePct: f.daily.precipitation_probability_max[i],
      precipMm: f.daily.precipitation_sum[i],
    })),
  };
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
