import { ATTACKS, findAttack, insiderDb } from "@vula/attacks";
import { auditorDb, runReconcile, runVerifyLog } from "@vula/verifier/run";
import { reportFindings } from "@vula/verifier/sources";
import { isDemoMode, requireAuditor } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  return Response.json(
    isDemoMode() ? ATTACKS.map(({ id, title, story, detectedBy, expected, destructive, requires }) => ({ id, title, story, detectedBy, expected, destructive: !!destructive, requires: requires ?? null })) : [],
  );
}

/** DEMO MODE ONLY: runs a scripted insider attack against the demo DB, then the matching verifier. */
export async function POST(req: Request) {
  const user = await requireAuditor(req);
  if (user instanceof Response) return user;
  if (!isDemoMode()) return Response.json({ error: "demo mode is off" }, { status: 403 });
  const { id } = (await req.json()) as { id: string };
  const attack = findAttack(id);
  let done: string;
  try {
    done = await attack.run(insiderDb());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
  if (attack.detectedBy === "log-server watchdog") {
    return Response.json({ attack: { id, title: attack.title }, done, detection: "pending", note: "the watchdog raises an alert once the heartbeat gap exceeds the threshold" });
  }
  const report = attack.detectedBy === "vula reconcile" ? await runReconcile() : await runVerifyLog();
  await reportFindings(auditorDb(), report.findings, `dashboard attack ${id}`);
  return Response.json({
    attack: { id, title: attack.title },
    done,
    detection: attack.detectedBy,
    ok: report.ok,
    firstBroken: "firstBroken" in report ? report.firstBroken : null,
    findings: report.findings.filter((f) => f.severity !== "info"),
  });
}
