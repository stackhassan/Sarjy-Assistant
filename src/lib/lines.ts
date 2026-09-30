/**
 * Fixed lines the app itself says (reprompts, notices). Shared by client and server:
 * /api/tts voices them by id, so they come out in Sarjy's normal voice without
 * letting a client get arbitrary text voiced.
 */
export const APP_LINES = {
  /** 1st "didn't catch that": rephrase briefly and ask again (Google conversation design). */
  reprompt1: "Sorry, I didn't catch that. Could you say it again?",
  /** 2nd+ in a row: add help, offer another way in. */
  reprompt2: "I'm having trouble hearing you. You can also type your message below.",
  /** Said once when the voice has to switch to the browser's, so the change isn't a surprise. */
  voiceChange: "Quick heads-up, my voice might sound a bit different for a moment.",
  /** The server couldn't be reached at all. */
  unreachable: "Sorry, I couldn't reach my brain just now. Could you try again in a moment?",
} as const;

export type AppLineId = keyof typeof APP_LINES;

export function isAppLineId(id: unknown): id is AppLineId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(APP_LINES, id);
}
