/**
 * Runs the two verifications against the real data sources. Shared by the CLI and the dashboard's
 * "Run attack" button. The auditor trusts only the chain RPC + the TAR id.
 */
import { createTarReader, explorerTxUrl, isTarId } from "@vula/compellio";
import { connect, loadEnv, type Sql } from "@vula/db";
import { reconcile } from "./reconcile";
import { verifyLog } from "./verify-log";
import { verifyEvent, type EventSelector, type VerifyEventReport } from "./verify-event";
import { verifyCtiTar, type CtiVerification } from "./verify-cti";
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

/**
 * Parses the CLI/dashboard `--id`: a plain integer = leaf index; `source:id` or `#id` = source id
 * (e.g. `app_audit:123`, `supabase.auth:<uuid>`); anything else = source id.
 */
export function parseEventSelector(id: string): EventSelector {
  const t = id.trim();
  if (/^\d+$/.test(t)) return { index: Number(t) };
  if (t.startsWith("#")) return { sourceId: t.slice(1) };
  const m = /^((?:supabase\.)?(?:app_audit|auth)|vula\.heartbeat|ci\.release):(.+)$/.exec(t);
  if (m) return { source: m[1]!.includes(".") ? m[1]! : `supabase.${m[1]}`, sourceId: m[2]! };
  return { sourceId: t };
}

export async function runVerifyEvent(
  selector: EventSelector,
  opts: AuditOptions = {},
): Promise<VerifyEventReport & { pinned: boolean; payloadSource: string; anchorTx: { txHash: string; explorer: string | null } | null }> {
  const sql = auditorDb();
  const { tarId, pinned } = await resolveTarId(sql, opts.tar);
  const reader = createTarReader({ rpcUrl: opts.rpc || process.env.CHAIN_RPC_URL || "http://localhost:8545", tarId });
  await reader.assertChain();
  const payloads = opts.payloads === "db" ? dbPayloadSource(sql) : dataUriPayloadSource(reader);
  const report = await verifyEvent({ chain: reader, payloads, leaves: dbLeafSource(sql), selector, trustedPublicKey: opts.pubkey });
  // Convenience only (explorer link): the tx hash comes from the untrusted DB; the proof never depends on it.
  let anchorTx: { txHash: string; explorer: string | null } | null = null;
  if (report.anchor) {
    const rows = await sql<{ tx_hash: string | null }[]>`select tx_hash from vula.checkpoints where tar_version = ${report.anchor.version} and status = 'anchored'`;
    const tx = rows[0]?.tx_hash;
    if (tx) anchorTx = { txHash: tx, explorer: explorerTxUrl(reader.chainId, tx) };
  }
  return { ...report, pinned, payloadSource: payloads.name, anchorTx };
}

export { explorerTxUrl };

// ------------------------------------------------------------------------------------- BCBCTI (threat intel)
export interface CtiOptions {
  /** BCBCTI TAXII 2.1 server (the partners' exchange). */
  bcbcti?: string;
  /** Untrusted host for the TAR payloads BCBCTI registered (its Registry API). */
  registry?: string;
  rpc?: string;
}

export interface CtiReportEntry extends CtiVerification {
  objectId: string;
  dateAdded: string;
}

export interface CtiReport {
  ok: boolean;
  server: string;
  entries: CtiReportEntry[];
}

const TAXII = "application/taxii+json;version=2.1";

/**
 * The partner's (e.g. a CERT's) view: list what BCBCTI shared, and verify every entry from the chain. Needs no
 * Vula database, no log server and no trust in BCBCTI or the Registry API.
 */
export async function runVerifyCti(opts: CtiOptions = {}): Promise<CtiReport> {
  const server = (opts.bcbcti || process.env.BCBCTI_URL || "http://localhost:8090").replace(/\/$/, "");
  const registry = (opts.registry || process.env.BCBCTI_REGISTRY_URL || "http://localhost:6061").replace(/\/$/, "");
  const rpc = opts.rpc || process.env.CHAIN_RPC_URL || "http://localhost:8545";
  const res = await fetch(`${server}/api/collections/default/manifest`, { headers: { Accept: TAXII } });
  if (!res.ok) throw new Error(`BCBCTI manifest -> HTTP ${res.status}`);
  const manifest = (await res.json()) as {
    objects?: { id: string; date_added: string; x_bcbcti_registry_tar_id: string }[];
  };
  const entries: CtiReportEntry[] = [];
  for (const m of manifest.objects ?? []) {
    const chain = createTarReader({ rpcUrl: rpc, tarId: m.x_bcbcti_registry_tar_id });
    await chain.assertChain();
    const r = await verifyCtiTar({
      chain,
      async fetchTarPayload(version) {
        // DCAP.Web REST versions are 1-based; `Accept: text/plain` returns the exact stored body.
        const p = await fetch(`${registry}/api/v1/TAR/version/raw/${m.x_bcbcti_registry_tar_id}:${version + 1}`, {
          headers: { Accept: "text/plain" },
        }).catch(() => null);
        return p?.ok ? p.text() : null;
      },
      async fetchObject(url) {
        const o = await fetch(url).catch(() => null);
        return o?.ok ? o.text() : null;
      },
    });
    entries.push({ ...r, objectId: m.id, dateAdded: m.date_added });
  }
  return { ok: entries.every((e) => e.ok), server, entries };
}
