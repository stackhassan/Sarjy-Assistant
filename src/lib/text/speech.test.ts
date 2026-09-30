import { describe, expect, it } from "vitest";
import { toSpeech } from "./speech";

describe("toSpeech", () => {
  it("expands units and ranges for the voice", () => {
    expect(toSpeech("It's 32°C with 9 km/h winds, 12% rain, highs 30–33°C.")).toBe(
      "It's 32 degrees Celsius with 9 kilometres per hour winds, 12 percent rain, highs 30 to 33 degrees Celsius.",
    );
    expect(toSpeech("90°F and 5 mph, 2 mm of rain")).toBe("90 degrees Fahrenheit and 5 miles per hour, 2 millimetres of rain");
  });
  it("leaves ordinary text alone", () => {
    expect(toSpeech("Hi! I'm Sarjy.")).toBe("Hi! I'm Sarjy.");
  });
});
