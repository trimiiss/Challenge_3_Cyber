import { parseEventSelector, runVerifyEvent } from "@vula/verifier/run";
import type { EventSelector } from "@vula/verifier";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * vula verify-event for the Verify page. Body: { id: "37" | "app_audit:123" | ... } or { event: {...} }.
 * The proof is checked against the root read from the chain; nothing the DB says is trusted.
 */
export async function POST(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as { id?: string; event?: unknown };
  let selector: EventSelector;
  if (body.event !== undefined) selector = { event: body.event };
  else if (body.id && String(body.id).trim()) selector = parseEventSelector(String(body.id));
  else return Response.json({ error: "give a leaf index, a source id or an event JSON" }, { status: 400 });
  try {
    return Response.json(await runVerifyEvent(selector));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
