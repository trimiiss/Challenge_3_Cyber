/**
 * Runs the two verifications against the real data sources. Shared by the CLI and the dashboard's
 * "Run attack" button. The auditor trusts only the chain RPC + the TAR id.
 */
import { createTarReader, explorerTxUrl, isTarId } from "@vula/compellio";
import { connect, loadEnv, type Sql } from "@vula/db";
import { reconcile } from "./reconcile";
import { verifyLog } from "./verify-log";
import type { ReconcileReport, VerifyLogReport } from "./types";
import {
  capturedEvents,
  dataUriPayloadSource,
  dbLeafSource,
  dbPayloadSource,
  dbReconcileSource,
  storageBatchSource,
} from "./sources";

loadEnv();

export interface AuditOptions {
  tar?: string;
  rpc?: string;
  payloads?: "datauri" | "db";
  pubkey?: string;
  batches?: boolean;
}

let shared: Sql | null = null;
export function auditorDb(): Sql {
  shared ??= connect("vula_auditor", { max: 2 });
  return shared;
}

export async function closeAuditorDb(): Promise<void> {
  await shared?.end({ timeout: 5 });
  shared = null;
}

/** The TAR id should be pinned out of band (it is the auditor's root of trust). */
export async function resolveTarId(sql: Sql, explicit?: string): Promise<{ tarId: string; pinned: boolean }> {
  const pinned = explicit || process.env.VULA_TAR_ID;
  if (pinned) {
    if (!isTarId(pinned)) throw new Error(`not a TAR id: ${pinned}`);
    return { tarId: pinned, pinned: true };
  }
  const rows = await sql<{ value: { tarId: string } }[]>`select value from vula.config where key = 'tar'`;
  const tarId = rows[0]?.value.tarId;
  if (!tarId) throw new Error("no TAR id: pass --tar or set VULA_TAR_ID");
  return { tarId, pinned: false };
}

export async function runVerifyLog(opts: AuditOptions = {}): Promise<VerifyLogReport & { pinned: boolean; payloadSource: string }> {
  const sql = auditorDb();
  const { tarId, pinned } = await resolveTarId(sql, opts.tar);
  const reader = createTarReader({ rpcUrl: opts.rpc || process.env.CHAIN_RPC_URL || "http://localhost:8545", tarId });
  await reader.assertChain();
  const payloads = opts.payloads === "db" ? dbPayloadSource(sql) : dataUriPayloadSource(reader);
  const batches =
    opts.batches === false || !process.env.AUDITOR_EMAIL
      ? undefined
      : storageBatchSource({
          url: process.env.SUPABASE_URL!,
          key: process.env.SUPABASE_PUBLISHABLE_KEY!,
          email: process.env.AUDITOR_EMAIL!,
          password: process.env.AUDITOR_PASSWORD!,
        });
  const report = await verifyLog({
    chain: reader,
    payloads,
    leaves: dbLeafSource(sql),
    batches,
    trustedPublicKey: opts.pubkey,
    heartbeatGapMs: Number(process.env.HEARTBEAT_GAP_MS || 150_000),
  });
  return { ...report, pinned, payloadSource: payloads.name };
}

export async function runReconcile(): Promise<ReconcileReport> {
  const sql = auditorDb();
  return reconcile(await capturedEvents(sql), dbReconcileSource(sql));
}

export { explorerTxUrl };
