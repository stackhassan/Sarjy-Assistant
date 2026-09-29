import { z } from "zod";
import type { TurnEvent } from "@/lib/events";
import { runTurn } from "@/lib/orchestrator";
import { chaosFromRequest, withContext } from "@/lib/reliability/context";

export const maxDuration = 30;

const body = z.object({
  // A spoken turn is a few hundred characters; tight caps bound what guards must screen.
  text: z.string().trim().min(1).max(1500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000), sig: z.string().max(200).optional() }))
    .max(50)
    .default([]),
  timeZone: z.string().max(64).default("UTC"),
});

/** Runs one turn and streams TurnEvents back as Server-Sent Events. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });

  const timeZone = Intl.supportedValuesOf("timeZone").includes(parsed.data.timeZone) ? parsed.data.timeZone : "UTC";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: TurnEvent) => {
        if (request.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      };
      try {
        // Guard bypass is never available over HTTP; chaos only affects this request.
        await withContext({ chaos: chaosFromRequest(request) }, () =>
          runTurn({ ...parsed.data, timeZone }, emit, request.signal),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
