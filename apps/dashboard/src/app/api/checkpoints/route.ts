import { explorerTxUrl } from "@vula/compellio";
import { auditorDb } from "@vula/verifier/run";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const sql = auditorDb();
  const [tar] = await sql<{ value: { chainId: number } }[]>`select value from vula.config where key = 'tar'`;
  const rows = await sql<
    {
      seq: number; tree_size: number; root: string; checksum: string; status: string; tar_version: number | null;
      tx_hash: string | null; anchored_at: Date | null; attempts: number; last_error: string | null;
      issued_at: string; prev_tree_size: number; key_id: string;
    }[]
  >`
    select seq, tree_size, encode(root_hash, 'hex') as root, encode(checksum, 'hex') as checksum, status, tar_version,
           tx_hash, anchored_at, attempts, last_error, payload ->> 'issuedAt' as issued_at,
           (payload ->> 'prevTreeSize')::int as prev_tree_size, payload -> 'signer' ->> 'keyId' as key_id
    from vula.checkpoints order by seq desc limit 200`;
  return Response.json(
    rows.map((r) => ({ ...r, explorer: tar && r.tx_hash ? explorerTxUrl(tar.value.chainId, r.tx_hash) : null })),
  );
}
