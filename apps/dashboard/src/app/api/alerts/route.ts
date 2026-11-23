import { explorerAddressUrl, isTarId, parseTarId } from "@vula/compellio";
import { auditorDb } from "@vula/verifier/run";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const rows = await auditorDb()<{ cti: { tarId?: string } | null }[]>`
    select id, kind, severity, title, details, cti, created_at from vula.alerts order by id desc limit 200`;
  // Explorer link for the TAR BCBCTI registered (convenience only; `vula verify-cti` checks it from the chain).
  return Response.json(
    rows.map((r) => {
      const tar = r.cti?.tarId && isTarId(r.cti.tarId) ? parseTarId(r.cti.tarId) : null;
      return { ...r, ctiExplorer: tar ? explorerAddressUrl(tar.chainId, tar.address) : null };
    }),
  );
}
