import { memoryFromRequest } from "@/lib/memory/auth";
import { MemoryError } from "@/lib/memory/store";

/** The memory drawer: list your facts (GET), delete one (?key=) or all (DELETE). Acts as the caller via RLS. */
export async function GET(request: Request) {
  const store = memoryFromRequest(request);
  if (!store) return Response.json({ facts: [], available: false });
  try {
    return Response.json({ facts: await store.list(), available: true });
  } catch (err) {
    if (err instanceof MemoryError) return Response.json({ facts: [], available: false }, { status: 503 });
    throw err;
  }
}

export async function DELETE(request: Request) {
  const store = memoryFromRequest(request);
  if (!store) return Response.json({ error: "Not signed in" }, { status: 401 });
  const key = new URL(request.url).searchParams.get("key");
  try {
    if (key) return Response.json({ removed: await store.remove(key) });
    return Response.json({ removed: await store.removeAll() });
  } catch (err) {
    if (err instanceof MemoryError) return Response.json({ error: "Memory unavailable" }, { status: 503 });
    throw err;
  }
}
