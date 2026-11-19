import { auditorDb } from "@vula/verifier/run";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const rows = await auditorDb()`
    select id, kind, severity, title, details, created_at from vula.alerts order by id desc limit 200`;
  return Response.json(rows);
}
