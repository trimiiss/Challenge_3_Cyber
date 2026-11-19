import type { Sql } from "@vula/db";
import type { CheckpointPayload, VulaEvent } from "@vula/core";

export interface LeafRow {
  index: number;
  leaf_hash: Buffer;
  event: VulaEvent;
}

export interface CheckpointRow {
  seq: number;
  tree_size: number;
  root_hash: Buffer;
  payload: CheckpointPayload;
  checksum: Buffer;
  status: "pending" | "anchored" | "failed";
  tar_version: number | null;
  tx_hash: string | null;
  anchored_at: Date | null;
  attempts: number;
  last_error: string | null;
}

export type Severity = "info" | "warning" | "critical";

/** All DB access of the log server, as the least-privilege `vula_log` role. */
export class Store {
  constructor(readonly sql: Sql) {}

  async loadLeaves(): Promise<LeafRow[]> {
    return this.sql<LeafRow[]>`select index, leaf_hash, event from vula.leaves order by index`;
  }

  /** One round trip for the whole batch (the DB is in the cloud). */
  async insertLeaves(rows: { index: number; leafHash: string; event: VulaEvent }[]): Promise<void> {
    if (rows.length === 0) return;
    await this.sql`
      insert into vula.leaves (index, leaf_hash, event)
      select (x ->> 'index')::bigint, decode(x ->> 'leafHash', 'hex'), x -> 'event'
      from jsonb_array_elements(${this.sql.json(rows as never)}) as x`;
  }

  async loadCheckpoints(): Promise<CheckpointRow[]> {
    return this.sql<CheckpointRow[]>`select * from vula.checkpoints order by seq`;
  }

  async insertCheckpoint(c: { seq: number; treeSize: number; rootHash: Buffer; payload: CheckpointPayload; checksum: Buffer }) {
    await this.sql`
      insert into vula.checkpoints (seq, tree_size, root_hash, payload, checksum, status)
      values (${c.seq}, ${c.treeSize}, ${c.rootHash}, ${this.sql.json(c.payload as never)}, ${c.checksum}, 'pending')`;
  }

  async markAnchored(seq: number, tarVersion: number, txHash: string): Promise<void> {
    await this.sql`
      update vula.checkpoints
      set status = 'anchored', tar_version = ${tarVersion}, tx_hash = ${txHash}, anchored_at = now(), last_error = null
      where seq = ${seq}`;
  }

  async markFailed(seq: number, error: string): Promise<void> {
    await this.sql`
      update vula.checkpoints set status = 'failed', attempts = attempts + 1, last_error = ${error.slice(0, 2000)}
      where seq = ${seq}`;
  }

  async getConfig<T>(key: string): Promise<T | null> {
    const rows = await this.sql<{ value: T }[]>`select value from vula.config where key = ${key}`;
    return rows[0]?.value ?? null;
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.sql`
      insert into vula.config (key, value) values (${key}, ${this.sql.json(value as never)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }

  async alert(kind: string, severity: Severity, title: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.sql`
      insert into vula.alerts (kind, severity, title, details)
      values (${kind}, ${severity}, ${title}, ${this.sql.json(details as never)})`;
  }
}
