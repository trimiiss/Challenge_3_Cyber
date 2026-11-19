/**
 * End-to-end check of CLAUDE.md M3: "every MVP attack produces the expected detection; clean run = all ✅".
 * Runs against the LIVE stack (Supabase cloud + chain + DCAP.Web + log server + collector).
 *
 *   pnpm e2e:attacks          (destructive: tampers with the demo data; `pnpm attack reset` afterwards)
 */
import { closeInsiderDb, findAttack, insiderDb } from "@vula/attacks";
import { auditorDb, closeAuditorDb, runReconcile, runVerifyLog } from "@vula/verifier/run";
import type { Finding } from "@vula/verifier";

const LOG = process.env.LOG_SERVER_URL || "http://localhost:4000";
const GAP_MS = Number(process.env.HEARTBEAT_GAP_MS || 150_000);
let failures = 0;

const codes = (f: Finding[]) => [...new Set(f.filter((x) => x.severity !== "info").map((x) => x.code))];
function expect(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}  ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function status(): Promise<{ treeSize: number; lastAnchored?: { treeSize: number } }> {
  return (await fetch(`${LOG}/v1/status`)).json() as never;
}

/** Waits until every source row is captured AND everything captured is anchored. */
async function waitForAnchoredQuiet(): Promise<void> {
  const sql = auditorDb();
  for (let i = 0; i < 60; i++) {
    const [{ max }] = (await sql`select coalesce(max(id), 0)::int as max from app_audit.events`) as unknown as [{ max: number }];
    const [{ cur }] = (await sql`
      select coalesce((cursor ->> 'lastId')::int, 0) as cur from vula.collector_state where source = 'supabase.app_audit'`) as unknown as [{ cur: number }];
    const s = await status();
    if (cur >= max && s.lastAnchored?.treeSize === s.treeSize) return;
    await sleep(5000);
  }
  throw new Error("log did not settle (collector / anchoring stuck?)");
}

console.log("\n▶ Clean run (wait until everything captured is anchored)");
await waitForAnchoredQuiet();
let v = await runVerifyLog();
let r = await runReconcile();
expect("verify-log clean", v.ok, `${v.totalVersions} checkpoints, ${v.anchoredTreeSize} events`);
expect("reconcile clean", r.ok, `${r.capturedEvents} captured events`);

console.log("\n▶ Attack 2: change grade 6 -> 10 and rewrite the matching audit record");
console.log(`  ${await findAttack("2").run(insiderDb())}`);
r = await runReconcile();
expect("reconcile flags modified audit row", codes(r.findings).includes("modified_audit_row"), codes(r.findings).join(", "));
expect("reconcile flags unexplained grade change", codes(r.findings).includes("unexplained_change"),
  r.findings.find((f) => f.code === "unexplained_change")?.message ?? "");

console.log("\n▶ Attack 1: delete an audit record");
console.log(`  ${await findAttack("1").run(insiderDb())}`);
r = await runReconcile();
expect("reconcile flags deleted audit row", codes(r.findings).includes("deleted_audit_row"),
  r.findings.find((f) => f.code === "deleted_audit_row")?.message ?? "");

console.log("\n▶ Attack 4: edit a leaf in vula.leaves (hash recomputed)");
console.log(`  ${await findAttack("4").run(insiderDb())}`);
v = await runVerifyLog();
expect("verify-log fails at the covering checkpoint", !v.ok && codes(v.findings).includes("root_mismatch"),
  `first broken: v${v.firstBroken?.version}`);
const altered = v.findings.find((f) => f.code === "leaf_altered");
expect("verify-log pinpoints the altered leaf", !!altered, altered?.message ?? "");

console.log("\n▶ Attack 5: delete the newest anchored leaves (truncation)");
console.log(`  ${await findAttack("5").run(insiderDb())}`);
v = await runVerifyLog();
expect("verify-log flags truncation", codes(v.findings).includes("log_truncated"),
  v.findings.find((f) => f.code === "log_truncated")?.message ?? "");

console.log(`\n▶ Attack 8: stop the collector (alert expected within ${GAP_MS / 1000} s)`);
const t0 = new Date();
console.log(`  ${await findAttack("8").run(insiderDb())}`);
let alert: { title: string } | undefined;
for (let waited = 0; waited < GAP_MS + 60_000 && !alert; waited += 5000) {
  await sleep(5000);
  const rows = await auditorDb()<{ title: string }[]>`
    select title from vula.alerts where kind = 'heartbeat_gap' and created_at >= ${t0} order by id desc limit 1`;
  alert = rows[0];
}
expect("watchdog raised a heartbeat-gap alert", !!alert, alert?.title ?? "none");

console.log(failures === 0 ? "\nE2E ✅ every MVP attack was detected\n" : `\nE2E ❌ ${failures} expectation(s) failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
await closeInsiderDb();
await closeAuditorDb();
