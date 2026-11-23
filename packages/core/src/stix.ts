import { createHash } from "node:crypto";
import { jcsSha256 } from "./jcs";

/**
 * Vula alert -> STIX 2.1 `incident`, for the BCBCTI hand-off (Compellio's TAXII 2.1 server registers every STIX
 * object it receives as its own TAR). Partners and CERTs see THAT tampering happened, on which log and at which
 * anchored checkpoint, without the row data: grades, e-mails and diffs stay in the alert. `x_vula_alert_sha256`
 * commits to the full alert, so it can be proven later to someone allowed to see it.
 */

/** Fixed namespace for Vula's deterministic STIX ids (UUIDv5). */
export const VULA_STIX_NAMESPACE = "6d1f3c8e-5b0a-5e4a-9c7d-1a2b3c4d5e6f";

/** RFC 4122 §4.3 name-based UUID, SHA-1 (version 5). */
export function uuidV5(name: string, namespace: string = VULA_STIX_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error("namespace must be a UUID");
  const h = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export interface AlertRecord {
  id: number;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  details: Record<string, unknown>;
  created_at: string | Date;
}

export interface StixIncident {
  type: "incident";
  spec_version: "2.1";
  id: string;
  created: string;
  modified: string;
  name: string;
  description: string;
  labels: string[];
  external_references?: { source_name: string; description: string; external_id: string }[];
  x_vula_log_id: string;
  x_vula_alert_id: number;
  x_vula_kind: string;
  x_vula_severity: string;
  x_vula_layer: string | null;
  x_vula_checkpoint_version: number | null;
  x_vula_leaf_index: number | null;
  x_vula_log_tar_id: string | null;
  x_vula_alert_sha256: string;
}

/** What each layer means, in words a partner understands without seeing the data. */
const LAYER_TEXT: Record<string, string> = {
  "source-vs-log": "Audit records captured by Vula were deleted or changed afterwards in the source system",
  "log-vs-chain": "Vula's own stored log no longer reproduces the checkpoints anchored on-chain",
  liveness: "Audit collection went silent",
};

/** Log-server alerts carry no layer; their kind says which one it is. */
const KIND_LAYER: Record<string, string> = {
  heartbeat_gap: "liveness",
  log_tampered: "log-vs-chain",
  foreign_tar_version: "log-vs-chain",
  chain_conflict: "log-vs-chain",
  version_mismatch: "log-vs-chain",
};

const iso = (t: string | Date) => new Date(t).toISOString();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function alertToStixIncident(alert: AlertRecord, ctx: { logId: string; logTarId: string | null }): StixIncident {
  const d = alert.details ?? {};
  const layer = typeof d.layer === "string" ? d.layer : (KIND_LAYER[alert.kind] ?? null);
  const version = num(d.version);
  const index = num(d.index);
  const where = [
    version !== null ? `anchored checkpoint (TAR version) ${version}` : null,
    index !== null ? `leaf ${index}` : null,
  ].filter(Boolean);
  const created = iso(alert.created_at);
  return {
    type: "incident",
    spec_version: "2.1",
    id: `incident--${uuidV5(`${ctx.logId}/alert/${alert.id}`)}`,
    created,
    modified: created,
    name: `Audit log tampering detected: ${alert.kind}`,
    description:
      `${(layer && LAYER_TEXT[layer]) || "Vula raised a tamper-evidence alert"} (audit log "${ctx.logId}"` +
      `${where.length ? `, ${where.join(", ")}` : ""}). Detected by Vula, which anchors the log's Merkle roots ` +
      `as versions of a Compellio TAR; anyone can re-check them from the chain.`,
    labels: ["audit-log-tampering", alert.kind, alert.severity],
    ...(ctx.logTarId
      ? { external_references: [{ source_name: "vula", description: "Anchored audit log (Compellio TAR)", external_id: ctx.logTarId }] }
      : {}),
    x_vula_log_id: ctx.logId,
    x_vula_alert_id: alert.id,
    x_vula_kind: alert.kind,
    x_vula_severity: alert.severity,
    x_vula_layer: layer,
    x_vula_checkpoint_version: version,
    x_vula_leaf_index: index,
    x_vula_log_tar_id: ctx.logTarId,
    x_vula_alert_sha256: jcsSha256({ ...alert, created_at: created }),
  };
}
