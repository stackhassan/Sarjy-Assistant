/**
 * Turns display text into speakable text. The chat shows "32°C, 9 km/h, 12%" (easy to
 * read); the voice says "32 degrees Celsius, 9 kilometres per hour, 12 percent".
 * Used by /api/tts (after the signature check, which covers the display text) and by
 * the browser fallback voice, so both voices say the same thing.
 */
export function toSpeech(text: string): string {
  return text
    .replace(/(\d)\s*°\s*C\b/g, "$1 degrees Celsius")
    .replace(/(\d)\s*°\s*F\b/g, "$1 degrees Fahrenheit")
    .replace(/(\d)\s*°/g, "$1 degrees")
    .replace(/(\d)\s*km\/h\b/gi, "$1 kilometres per hour")
    .replace(/(\d)\s*mph\b/gi, "$1 miles per hour")
    .replace(/(\d)\s*mm\b/g, "$1 millimetres")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}
