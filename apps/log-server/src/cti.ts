/**
 * BCBCTI hand-off: every warning/critical alert is published as a STIX 2.1 `incident` to Compellio's BCBCTI
 * (TAXII 2.1), which registers it as its own TAR. From then on the alert itself is tamper-evident and partners
 * (another company, KOS-CERT) can pull it over TAXII and verify it from the chain (`vula verify-cti`).
 *
 * State per alert lives in vula.alerts.cti:
 *   { state: "submitted", objectId, statusId, submittedAt }
 *   { state: "registered", objectId, tarId, registryVersion, receiptId, registeredAt }
 *   { state: "failed", objectId, error }
 * One request in flight at a time, like the anchor worker.
 */
import { alertToStixIncident, type AlertRecord } from "@vula/core";
import type { Sql } from "@vula/db";

const TAXII = "application/taxii+json;version=2.1";

interface Cti {
  state: "submitted" | "registered" | "failed";
  objectId: string;
  statusId?: string;
  submittedAt?: string;
  tarId?: string;
  registryVersion?: number;
  receiptId?: string;
  registeredAt?: string;
  error?: string;
}

interface TaxiiStatus {
  status: "pending" | "complete";
  success_count: number;
  failure_count: number;
  failures?: { id: string; message?: string }[];
}

interface ManifestRecord {
  id: string;
  x_bcbcti_registry_tar_id: string;
  x_bcbcti_registry_receipt_id: string;
  x_bcbcti_registry_version_id: number;
}

export class CtiPublisher {
  private busy = false;
  constructor(
    private readonly sql: Sql,
    private readonly opts: { url: string; logId: string; logTarId: () => string | null },
  ) {}

  private async taxii<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.opts.url}${path}`, {
      ...init,
      headers: { Accept: TAXII, ...(init.body ? { "Content-Type": TAXII } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`BCBCTI ${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  private save(id: number, cti: Cti) {
    return this.sql`update vula.alerts set cti = ${this.sql.json(cti as never)} where id = ${id}`;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.publishNew();
      await this.confirmSubmitted();
    } finally {
      this.busy = false;
    }
  }

  private async publishNew(): Promise<void> {
    const rows = await this.sql<AlertRecord[]>`
      select id, kind, severity, title, details, created_at from vula.alerts
      where cti is null and severity <> 'info' order by id limit 5`;
    for (const a of rows) {
      const incident = alertToStixIncident(a, { logId: this.opts.logId, logTarId: this.opts.logTarId() });
      try {
        const status = await this.taxii<{ id: string } & TaxiiStatus>("/api/collections/default/objects", {
          method: "POST",
          body: JSON.stringify({ objects: [incident] }),
        });
        if (status.failure_count > 0) {
          await this.save(a.id, { state: "failed", objectId: incident.id, error: status.failures?.[0]?.message ?? "rejected" });
          console.error(`[cti] alert ${a.id} rejected by BCBCTI: ${status.failures?.[0]?.message ?? "?"}`);
          continue;
        }
        await this.save(a.id, { state: "submitted", objectId: incident.id, statusId: status.id, submittedAt: new Date().toISOString() });
        console.log(`[cti] alert ${a.id} (${a.kind}) shared as ${incident.id}, TAXII status ${status.id}`);
      } catch (e) {
        // BCBCTI down: leave cti null and retry on the next tick
        console.error(`[cti] ${(e as Error).message}`);
        return;
      }
    }
  }

  private async confirmSubmitted(): Promise<void> {
    const rows = await this.sql<{ id: number; cti: Cti }[]>`
      select id, cti from vula.alerts where cti ->> 'state' = 'submitted' order by id limit 10`;
    if (rows.length === 0) return;
    let manifest: ManifestRecord[] | null = null;
    for (const r of rows) {
      const status = await this.taxii<TaxiiStatus>(`/api/status/${r.cti.statusId}`);
      if (status.failure_count > 0) {
        await this.save(r.id, { ...r.cti, state: "failed", error: status.failures?.[0]?.message ?? "registration failed" });
        console.error(`[cti] alert ${r.id}: BCBCTI registration failed`);
        continue;
      }
      if (status.success_count === 0) continue; // still registering on-chain
      manifest ??= (await this.taxii<{ objects?: ManifestRecord[] }>("/api/collections/default/manifest")).objects ?? [];
      const m = manifest.find((x) => x.id === r.cti.objectId);
      if (!m) continue;
      await this.save(r.id, {
        state: "registered",
        objectId: r.cti.objectId,
        tarId: m.x_bcbcti_registry_tar_id,
        registryVersion: m.x_bcbcti_registry_version_id,
        receiptId: m.x_bcbcti_registry_receipt_id,
        registeredAt: new Date().toISOString(),
      });
      console.log(`[cti] alert ${r.id} registered as TAR ${m.x_bcbcti_registry_tar_id}`);
    }
  }
}
