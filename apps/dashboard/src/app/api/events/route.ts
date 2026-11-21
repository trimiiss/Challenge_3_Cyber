import { auditorDb } from "@vula/verifier/run";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Newest captured events (leaves), with the checkpoint that sealed each one (null = not anchored yet). */
export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const hideHeartbeats = url.searchParams.get("heartbeats") === "0";
  const sql = auditorDb();
  const cps = await sql<{ seq: number; tree_size: number; tar_version: number }[]>`
    select seq, tree_size, tar_version from vula.checkpoints where status = 'anchored' order by seq`;
  const rows = await sql<
    { index: number; leaf_hash: string; event: Record<string, unknown>; captured_at: Date }[]
  >`
    select index, encode(leaf_hash, 'hex') as leaf_hash, event, captured_at from vula.leaves
    where (${source}::text is null or event ->> 'source' = ${source})
      and (not ${hideHeartbeats} or event ->> 'source' <> 'vula.heartbeat')
    order by index desc limit 200`;
  const sealedBy = (i: number) => cps.find((c) => c.tree_size > i) ?? null;
  return Response.json({
    anchoredTreeSize: cps.at(-1)?.tree_size ?? 0,
    events: rows.map((r) => {
      const c = sealedBy(r.index);
      return {
        index: r.index,
        leafHash: r.leaf_hash,
        capturedAt: r.captured_at,
        event: r.event,
        sealedIn: c ? { seq: c.seq, tarVersion: c.tar_version } : null,
      };
    }),
  });
}
