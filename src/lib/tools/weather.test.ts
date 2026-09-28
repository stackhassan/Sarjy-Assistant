import { describe, expect, it } from "vitest";
import { getWeather, normalizeForecast, pickPlaces } from "./weather";

const geo = {
  results: [
    { name: "Paris", admin1: "Île-de-France", country: "France", latitude: 48.85, longitude: 2.35, timezone: "Europe/Paris" },
    { name: "Paris", admin1: "Texas", country: "United States", latitude: 33.66, longitude: -95.55, timezone: "America/Chicago" },
  ],
};

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

describe("normalizeForecast", () => {
  it("rounds values and maps WMO codes", () => {
    const place = pickPlaces(geo, "Paris")[0];
    const r = normalizeForecast(
      {
        current: { time: "2026-09-28T14:00", temperature_2m: 18.6, apparent_temperature: 17.2, relative_humidity_2m: 61, weather_code: 2, wind_speed_10m: 11.4 },
        daily: {
          time: ["2026-09-28"],
          weather_code: [61],
          temperature_2m_max: [19.4],
          temperature_2m_min: [11.5],
          precipitation_probability_max: [70],
          precipitation_sum: [2.1],
        },
      },
      place,
      [],
      false,
    );
    expect(r.ok && r.current).toMatchObject({ temperature: 19, condition: "partly cloudy" });
    expect(r.ok && r.daily[0]).toMatchObject({ weekday: "Monday", high: 19, low: 12, condition: "light rain", precipChancePct: 70 });
  });
});

describe("getWeather", () => {
  it("refuses forecasts beyond the supported range without calling the API", async () => {
    expect(await getWeather({ location: "Lahore", days: 30 })).toMatchObject({ ok: false, error: "out_of_range" });
  });
  it("rejects invalid arguments", async () => {
    expect(await getWeather({ days: 2 })).toMatchObject({ ok: false, error: "invalid_args" });
  });
});
