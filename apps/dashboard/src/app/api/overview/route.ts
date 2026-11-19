import { explorerAddressUrl, explorerTxUrl, parseTarId } from "@vula/compellio";
import { auditorDb } from "@vula/verifier/run";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const sql = auditorDb();

  const [counts] = await sql<{ leaves: number; audit: number; auth: number; heartbeats: number; last_captured: Date | null }[]>`
    select count(*)::int as leaves,
           count(*) filter (where event ->> 'source' = 'supabase.app_audit')::int as audit,
           count(*) filter (where event ->> 'source' = 'supabase.auth')::int as auth,
           count(*) filter (where event ->> 'source' = 'vula.heartbeat')::int as heartbeats,
           max(captured_at) as last_captured
    from vula.leaves`;
  const [cps] = await sql<{ total: number; anchored: number; pending: number }[]>`
    select count(*)::int as total,
           count(*) filter (where status = 'anchored')::int as anchored,
           count(*) filter (where status <> 'anchored')::int as pending
    from vula.checkpoints`;
  const [last] = await sql<{ seq: number; tree_size: number; root: string; tar_version: number; tx_hash: string; anchored_at: Date }[]>`
    select seq, tree_size, encode(root_hash, 'hex') as root, tar_version, tx_hash, anchored_at
    from vula.checkpoints where status = 'anchored' order by seq desc limit 1`;
  const [tarRow] = await sql<{ value: { tarId: string; chainId: number; createdAt: string } }[]>`
    select value from vula.config where key = 'tar'`;
  const [alerts] = await sql<{ critical: number; warning: number }[]>`
    select count(*) filter (where severity = 'critical')::int as critical,
           count(*) filter (where severity = 'warning')::int as warning
    from vula.alerts where created_at > now() - interval '1 day'`;

  let logServer: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${process.env.LOG_SERVER_URL || "http://localhost:4000"}/v1/status`, { signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (res.ok) logServer = await res.json();
  } catch {
    logServer = null;
  }

  const tar = tarRow?.value ?? null;
  const address = tar ? parseTarId(tar.tarId).address : null;
  return Response.json({
    counts,
    checkpoints: cps,
    lastAnchored: last
      ? { ...last, explorer: tar && last.tx_hash ? explorerTxUrl(tar.chainId, last.tx_hash) : null }
      : null,
    tar: tar ? { ...tar, address, explorer: address ? explorerAddressUrl(tar.chainId, address) : null } : null,
    alerts,
    logServer,
    chainRpc: process.env.CHAIN_RPC_URL || "http://localhost:8545",
    registryMode: process.env.REGISTRY_MODE || "dcap-local",
  });
}
