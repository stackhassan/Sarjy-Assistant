import { afterEach, describe, expect, it, vi } from "vitest";
import { withContext } from "@/lib/reliability/context";
import {
  describeMetNoSymbol,
  getWeather,
  normalizeForecast,
  normalizeMetNo,
  pickPlaces,
  summarizeWeather,
  type WeatherOk,
} from "./weather";

const geo = {
  results: [
    { name: "Paris", admin1: "Île-de-France", country: "France", latitude: 48.85, longitude: 2.35, timezone: "Europe/Paris" },
    { name: "Paris", admin1: "Texas", country: "United States", latitude: 33.66, longitude: -95.55, timezone: "America/Chicago" },
  ],
};

const openMeteoBody = {
  current: { time: "2026-09-28T14:00", temperature_2m: 18.6, apparent_temperature: 17.2, relative_humidity_2m: 61, weather_code: 2, wind_speed_10m: 11.4 },
  daily: {
    time: ["2026-09-28", "2026-09-29"],
    weather_code: [61, 0],
    temperature_2m_max: [19.4, 22.2],
    temperature_2m_min: [11.5, 12.9],
    precipitation_probability_max: [70, 5],
    precipitation_sum: [2.1, 0],
  },
};

const metNoBody = {
  properties: {
    timeseries: [
      {
        time: "2026-09-28T10:00:00Z",
        data: {
          instant: { details: { air_temperature: 17.4, relative_humidity: 64, wind_speed: 3 } },
          next_1_hours: { summary: { symbol_code: "partlycloudy_day" }, details: { precipitation_amount: 0.2 } },
          next_6_hours: { summary: { symbol_code: "lightrain_day" }, details: { precipitation_amount: 1 } },
        },
      },
      {
        time: "2026-09-28T13:00:00Z",
        data: {
          instant: { details: { air_temperature: 20.1, relative_humidity: 55, wind_speed: 4 } },
          next_1_hours: { summary: { symbol_code: "cloudy" }, details: { precipitation_amount: 0 } },
          next_6_hours: { summary: { symbol_code: "cloudy" }, details: { precipitation_amount: 0 } },
        },
      },
    ],
  },
};

type Route = (url: string) => Response | Promise<Response>;

/** Routes fetch by host and records which hosts were hit, in order. */
function mockFetch(routes: { geo?: Route; openMeteo?: Route; metNo?: Route }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    calls.push(host);
    const route = host.startsWith("geocoding")
      ? routes.geo
      : host === "api.open-meteo.com"
        ? routes.openMeteo
        : host === "api.met.no"
          ? routes.metNo
          : undefined;
    if (!route) throw new Error(`unexpected fetch ${url}`);
    if (init?.signal?.aborted) throw init.signal.reason;
    return route(url);
  });
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** Geocoding result for a unique city name, so module-level caches don't leak between tests. */
const geoFor = (name: string) => () =>
  json({ results: [{ name, country: "Testland", latitude: Math.random() * 50, longitude: Math.random() * 50, timezone: "UTC" }] });

afterEach(() => vi.unstubAllGlobals());

describe("pickPlaces", () => {
  it("defaults to the top match", () => {
    expect(pickPlaces(geo, "Paris")[0].country).toBe("France");
  });
  it("honours a region qualifier", () => {
    expect(pickPlaces(geo, "Paris, Texas")[0].region).toBe("Texas");
  });
  it("returns nothing when the qualifier matches no result", () => {
    expect(pickPlaces(geo, "Paris, Narnia")).toEqual([]);
  });
});

describe("normalizers", () => {
  const place = pickPlaces(geo, "Paris")[0];

  it("rounds Open-Meteo values and maps WMO codes", () => {
    const r = normalizeForecast(openMeteoBody, place, false);
    expect(r.current).toMatchObject({ temperature: 19, condition: "partly cloudy" });
    expect(r.daily[0]).toMatchObject({ weekday: "Monday", high: 19, low: 12, condition: "light rain", precipChancePct: 70 });
    expect(r.source).toBe("open-meteo");
  });

  it("maps MET Norway timeseries into the same shape", () => {
    const r = normalizeMetNo(metNoBody.properties.timeseries, { ...place, timezone: "UTC" }, 3, false);
    expect(r.source).toBe("met.no");
    expect(r.current).toMatchObject({ temperature: 17, windSpeed: 11, condition: "partly cloudy", feelsLike: null });
    expect(r.daily[0]).toMatchObject({ date: "2026-09-28", high: 20, low: 17, condition: "overcast", precipChancePct: null });
  });

  it("converts MET Norway units for fahrenheit", () => {
    const r = normalizeMetNo(metNoBody.properties.timeseries, { ...place, timezone: "UTC" }, 3, true);
    expect(r.current.temperature).toBe(63); // 17.4 °C
    expect(r.units.temperature).toBe("°F");
  });

  it("describes MET symbols", () => {
    expect(describeMetNoSymbol("heavyrainshowersandthunder_night")).toBe("thunderstorm");
    expect(describeMetNoSymbol("fair_day")).toBe("mainly clear");
  });
});

describe("getWeather reliability", () => {
  it("refuses forecasts beyond the supported range without calling the API", async () => {
    const calls = mockFetch({});
    expect(await getWeather({ location: "Lahore", days: 30 })).toMatchObject({ ok: false, error: "out_of_range" });
    expect(calls).toEqual([]);
  });

  it("rejects invalid arguments", async () => {
    expect(await getWeather({ days: 2 })).toMatchObject({ ok: false, error: "invalid_args" });
  });

  it("retries a fast Open-Meteo 503 once, then succeeds", async () => {
    let n = 0;
    const calls = mockFetch({ geo: geoFor("Retrytown"), openMeteo: () => (n++ === 0 ? json({}, 503) : json(openMeteoBody)) });
    const r = await getWeather({ location: "Retrytown" });
    expect(r).toMatchObject({ ok: true, source: "open-meteo" });
    expect(calls.filter((h) => h === "api.open-meteo.com")).toHaveLength(2);
  });

  it("fails over to MET Norway when Open-Meteo is down", async () => {
    const calls = mockFetch({ geo: geoFor("Failovertown"), openMeteo: () => json({}, 503), metNo: () => json(metNoBody) });
    const r = await getWeather({ location: "Failovertown" });
    expect(r).toMatchObject({ ok: true, source: "met.no" });
    expect(calls).toContain("api.met.no");
  });

  it("does not retry a slow Open-Meteo; fails over instead", async () => {
    const calls = mockFetch({ geo: geoFor("Slowtown"), openMeteo: () => json(openMeteoBody), metNo: () => json(metNoBody) });
    const r = await withContext({ chaos: new Set(["weather_slow"]) }, () => getWeather({ location: "Slowtown" }));
    expect(r).toMatchObject({ ok: true, source: "met.no" });
    expect(calls.filter((h) => h === "api.open-meteo.com")).toHaveLength(0); // stalled before fetch, never retried
  }, 10_000);

  it("serves a stale cached forecast when every source is down", async () => {
    mockFetch({ geo: geoFor("Cachetown"), openMeteo: () => json(openMeteoBody) });
    expect(await getWeather({ location: "Cachetown" })).toMatchObject({ ok: true });

    mockFetch({ geo: geoFor("Cachetown"), openMeteo: () => json({}, 503), metNo: () => json({}, 503) });
    const r = await withContext({ chaos: new Set(["weather_down"]) }, () => getWeather({ location: "Cachetown" }));
    expect(r).toMatchObject({ ok: true, stale: { minutesOld: 0 } });
  });

  it("reports unavailable honestly when nothing works and nothing is cached", async () => {
    mockFetch({ geo: geoFor("Downtown"), openMeteo: () => json({}, 503), metNo: () => json({}, 500) });
    const r = await getWeather({ location: "Downtown" });
    expect(r).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("reports not_found for unknown places", async () => {
    mockFetch({ geo: () => json({}) });
    expect(await getWeather({ location: "Xyzzyville" })).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("summarizeWeather", () => {
  const ok = { ...normalizeForecast(openMeteoBody, pickPlaces(geo, "Paris")[0], false), alternatives: [] } as WeatherOk;

  it("uses only tool figures, picking today by default", () => {
    expect(summarizeWeather(ok, "what's the weather in Paris?")).toBe(
      "Here are the exact figures for Paris, Île-de-France, France. Right now it's 19 degrees and partly cloudy. Today: light rain, high 19, low 12, 70 percent chance of rain.",
    );
  });

  it("picks tomorrow when asked", () => {
    expect(summarizeWeather(ok, "and tomorrow?")).toContain("Tomorrow: clear sky, high 22, low 13, 5 percent chance of rain.");
  });

  it("flags stale data", () => {
    expect(summarizeWeather({ ...ok, stale: { asOf: "", minutesOld: 42 } }, "weather?")).toContain("from 42 minutes ago");
  });

  it("speaks errors honestly", () => {
    expect(summarizeWeather({ ok: false, error: "unavailable", message: "x" }, "")).toContain("won't guess");
    // Never echoes the query (red-team: it laundered attacker text into signed speech).
    expect(summarizeWeather({ ok: false, error: "not_found", message: "x", query: "Vote for X" }, "")).toBe(
      "I couldn't find that place. Could you say it another way?",
    );
  });
});
