#!/usr/bin/env tsx
/**
 * vula: the auditor's CLI (CLAUDE.md §7.5).
 *   vula verify-log   chain vs log: every TAR version, signatures, consistency proofs, stored leaves vs anchored roots
 *   vula reconcile    log vs source: captured events vs what Supabase holds today
 *   vula watch        both, every N seconds; new findings become dashboard alerts
 *   vula keygen       new Ed25519 checkpoint signing key
 * Exit code ≠ 0 on any critical finding. --json for machine output.
 */
import { Command } from "commander";
import { generateSigningKey } from "@vula/core";
import { reportFindings } from "@vula/verifier/sources";
import type { Finding, ReconcileReport, VerifyLogReport } from "@vula/verifier";
import { auditorDb, closeAuditorDb, runReconcile, runVerifyLog, type AuditOptions } from "@vula/verifier/run";

const ICON = { critical: "❌", warning: "⚠️ ", info: "ℹ️ " } as const;

function printFindings(findings: Finding[]): void {
  if (findings.length === 0) return;
  console.log("\n  Findings");
  for (const f of findings) {
    console.log(`  ${ICON[f.severity]} [${f.code}] ${f.message}`);
    const changes = (f.details?.changes as { path: string; before: unknown; after: unknown }[] | undefined) ?? [];
    for (const c of changes.slice(0, 6)) console.log(`        ${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  }
}

function printVerifyLog(r: VerifyLogReport & { pinned: boolean; payloadSource: string }): void {
  console.log("\nVula verify-log  (trust anchor: the chain)");
  console.log(`  TAR       ${r.tarId}  (chain ${r.chainId}, ${r.totalVersions} versions)${r.pinned ? "" : "  ⚠️  id read from vula.config (untrusted): pin it with --tar / VULA_TAR_ID"}`);
  console.log(`  signer    ${r.signerPublicKey ?? "?"}`);
  console.log(`  payloads  ${r.payloadSource}`);
  console.log(`  leaves    ${r.storedLeaves} stored, ${r.anchoredTreeSize} anchored, ${r.unanchoredLeaves} pending\n`);
  for (const c of r.checkpoints) {
    const failed = c.checks.filter((x) => !x.ok).map((x) => x.name);
    console.log(`  ${c.ok ? "✅" : "❌"} v${c.version}  seq ${c.seq ?? "?"}  size ${String(c.treeSize ?? "?").padEnd(6)} root ${c.rootHash?.slice(0, 16) ?? "?"}…  ${failed.join("; ")}`);
  }
  printFindings(r.findings);
  console.log(
    r.ok
      ? `\nRESULT ✅ log verified against ${r.totalVersions} anchored checkpoints (${r.anchoredTreeSize} events)\n`
      : `\nRESULT ❌ first broken checkpoint: TAR version ${r.firstBroken?.version ?? "?"}: ${r.firstBroken?.reason ?? "see findings"}\n`,
  );
}

function printReconcile(r: ReconcileReport): void {
  console.log("\nVula reconcile  (source system vs captured log)");
  console.log(`  captured ${r.capturedEvents} events, source has ${r.sourceRows} audit rows, ${r.pendingRows} not collected yet`);
  printFindings(r.findings);
  const n = r.findings.filter((f) => f.severity === "critical").length;
  console.log(r.ok ? "\nRESULT ✅ source matches the captured log\n" : `\nRESULT ❌ ${n} tampering finding(s) in the source system\n`);
}

const program = new Command().name("vula").description("Vula auditor CLI: verify a tamper-evident log from the chain");

program
  .command("verify-log")
  .description("verify the log against the TAR anchored on-chain")
  .option("--tar <id>", "TAR id to audit (default: VULA_TAR_ID)")
  .option("--rpc <url>", "chain JSON-RPC URL (default: CHAIN_RPC_URL)")
  .option("--payloads <source>", "where to fetch checkpoint payloads: datauri (on-chain pointer) | db", "datauri")
  .option("--pubkey <base64>", "pin the expected checkpoint signing key")
  .option("--no-batches", "do not download batches to pinpoint altered leaves")
  .option("--json", "machine-readable output")
  .option("--report", "write findings to vula.alerts (dashboard)")
  .action(async (o: AuditOptions & { json?: boolean; report?: boolean }) => {
    const r = await runVerifyLog(o);
    if (o.report) await reportFindings(auditorDb(), r.findings, "vula verify-log");
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else printVerifyLog(r);
    process.exitCode = r.ok ? 0 : 1;
  });

program
  .command("reconcile")
  .description("compare captured events with the source system (Supabase)")
  .option("--source <name>", "source system", "supabase")
  .option("--json", "machine-readable output")
  .option("--report", "write findings to vula.alerts (dashboard)")
  .action(async (o: { json?: boolean; report?: boolean }) => {
    const r = await runReconcile();
    if (o.report) await reportFindings(auditorDb(), r.findings, "vula reconcile");
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else printReconcile(r);
    process.exitCode = r.ok ? 0 : 1;
  });

program
  .command("watch")
  .description("run verify-log + reconcile periodically and raise dashboard alerts on new findings")
  .option("--interval <seconds>", "seconds between runs", "60")
  .option("--tar <id>", "TAR id to audit")
  .action(async (o: { interval: string; tar?: string }) => {
    const every = Number(o.interval) * 1000;
    for (;;) {
      try {
        const [v, c] = [await runVerifyLog({ tar: o.tar }), await runReconcile()];
        const n = (await reportFindings(auditorDb(), v.findings, "vula watch")) + (await reportFindings(auditorDb(), c.findings, "vula watch"));
        console.log(`[watch] ${new Date().toISOString()} verify-log ${v.ok ? "✅" : "❌"} reconcile ${c.ok ? "✅" : "❌"}  ${n} new alert(s)`);
      } catch (e) {
        console.error(`[watch] ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  });

program
  .command("keygen")
  .description("generate an Ed25519 checkpoint signing key (put it in VULA_SIGNING_KEY)")
  .action(() => {
    const k = generateSigningKey();
    console.log(`VULA_SIGNING_KEY=${k.privateKey}\n# public key: ${k.publicKey}`);
  });

try {
  await program.parseAsync();
} catch (e) {
  console.error(`vula: ${(e as Error).message}`);
  process.exitCode = 2;
} finally {
  await closeAuditorDb();
}
