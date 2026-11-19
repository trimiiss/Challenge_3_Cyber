import { auditorDb, runReconcile, runVerifyLog } from "@vula/verifier/run";
import { reportFindings } from "@vula/verifier/sources";
import { requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs both verifications now (as the auditor) and raises alerts for new findings. */
export async function POST(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  const verify = await runVerifyLog();
  const rec = await runReconcile();
  await reportFindings(auditorDb(), verify.findings, "dashboard verify-log");
  await reportFindings(auditorDb(), rec.findings, "dashboard reconcile");
  return Response.json({
    verifyLog: {
      ok: verify.ok,
      totalVersions: verify.totalVersions,
      anchoredTreeSize: verify.anchoredTreeSize,
      firstBroken: verify.firstBroken,
      checkpoints: verify.checkpoints.map((c) => ({ version: c.version, ok: c.ok, treeSize: c.treeSize, failed: c.checks.filter((x) => !x.ok).map((x) => x.name) })),
      findings: verify.findings,
    },
    reconcile: { ok: rec.ok, capturedEvents: rec.capturedEvents, findings: rec.findings },
  });
}
