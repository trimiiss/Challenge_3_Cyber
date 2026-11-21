/**
 * End-to-end check of the §7 stretch items against the LIVE stack:
 *   verify-event (inclusion proof against the chain), attack 7 (stolen key -> forged TAR version),
 *   attack 6 (checkpoint store rewritten), attack 3 (Supabase Auth audit entries deleted; skipped if the project
 *   writes no Auth audit log to the database).
 *
 *   pnpm e2e:stretch          (destructive: forks the demo TAR; `pnpm demo:reset` afterwards)
 */
import { closeInsiderDb, findAttack, insiderDb } from "@vula/attacks";
import { auditorDb, closeAuditorDb, runReconcile, runVerifyEvent, runVerifyLog } from "@vula/verifier/run";
import type { Finding } from "@vula/verifier";

const LOG = process.env.LOG_SERVER_URL || "http://localhost:4000";
let failures = 0;
const codes = (f: Finding[]) => [...new Set(f.filter((x) => x.severity !== "info").map((x) => x.code))];
function expect(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}  ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitAnchored(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = (await (await fetch(`${LOG}/v1/status`)).json()) as { treeSize: number; lastAnchored?: { treeSize: number } };
    if (s.lastAnchored?.treeSize === s.treeSize) return;
    await sleep(5000);
  }
  throw new Error("log did not settle");
}

const sql = auditorDb();
console.log("\n▶ Clean run");
await waitAnchored();
const v0 = await runVerifyLog();
expect("verify-log clean", v0.ok, `${v0.totalVersions} checkpoints, ${v0.anchoredTreeSize} events`);

console.log("\n▶ verify-event: prove the newest anchored grade event against the chain");
const [grade] = await sql<{ index: number; source_id: string }[]>`
  select index, event ->> 'sourceId' as source_id from vula.leaves
  where event ->> 'action' like 'grade.%' and index < ${v0.anchoredTreeSize} order by index desc limit 1`;
if (!grade) throw new Error("no anchored grade event: enter a grade in the demo app first");
const e1 = await runVerifyEvent({ index: grade.index });
expect("leaf proves into the anchored root", e1.ok && e1.status === "included", `${e1.message}`);
const e2 = await runVerifyEvent({ source: "supabase.app_audit", sourceId: grade.source_id });
expect("same event found by source id", e2.ok && e2.index === grade.index, `app_audit:${grade.source_id} -> leaf ${e2.index}`);
const e3 = await runVerifyEvent({ event: e1.event });
expect("a held copy of the event proves too", e3.ok, `leaf ${e3.index}`);

console.log("\n▶ Attack 7: stolen signing key anchors a forged checkpoint that drops the grade event");
const t7 = new Date();
console.log(`  ${await findAttack("7").run(insiderDb())}`);
const v7 = await runVerifyLog();
const forgedVersion = v7.totalVersions - 1;
expect("verify-log: consistency proof fails at the forged version", codes(v7.findings).includes("inconsistent") && v7.firstBroken?.version === forgedVersion,
  v7.firstBroken?.reason ?? "");
expect("every earlier TAR version still verifies", v7.checkpoints.slice(0, forgedVersion).every((c) => c.ok), `v0..v${forgedVersion - 1} ✅`);
let foreign: { title: string } | undefined;
for (let i = 0; i < 12 && !foreign; i++) {
  await sleep(5000);
  [foreign] = await sql<{ title: string }[]>`select title from vula.alerts where kind = 'foreign_tar_version' and created_at >= ${t7} limit 1`;
}
expect("log server halted with a foreign_tar_version alert", !!foreign, foreign?.title ?? "none");

console.log("\n▶ Attack 6: rewrite leaves + vula.checkpoints so the database is self-consistent");
console.log(`  ${await findAttack("6").run(insiderDb())}`);
const v6 = await runVerifyLog();
const mismatch = v6.findings.find((f) => f.code === "payload_mismatch");
expect("verify-log: chain wins (payload_mismatch)", !!mismatch, mismatch?.message ?? codes(v6.findings).join(", "));
const e6 = await runVerifyEvent({ index: grade.index });
expect("verify-event no longer trusts the rewritten store", !e6.ok, `[${e6.status}] ${e6.message.slice(0, 120)}`);

console.log("\n▶ Attack 3: delete Supabase Auth audit log entries");
const [{ n }] = (await sql`select count(*)::int as n from vula.leaves where event ->> 'source' = 'supabase.auth'`) as unknown as [{ n: number }];
if (n === 0) {
  console.log("  ⏭  skipped: no auth audit entries captured (enable the Auth audit log in the database, sign in, retry)");
} else {
  console.log(`  ${await findAttack("3").run(insiderDb())}`);
  const r3 = await runReconcile();
  expect("reconcile flags deleted auth entries", codes(r3.findings).includes("deleted_auth_entry"),
    r3.findings.find((f) => f.code === "deleted_auth_entry")?.message ?? "");
}

console.log(failures === 0 ? "\nE2E ✅ every stretch detection works\n" : `\nE2E ❌ ${failures} expectation(s) failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
await closeInsiderDb();
await closeAuditorDb();
