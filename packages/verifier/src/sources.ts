/**
 * Concrete data sources for the verifier (CLI + dashboard). Everything here is UNTRUSTED input: the verifier
 * re-hashes it against the chain. DB access uses the read-only `vula_auditor` role.
 */
import { createClient } from "@supabase/supabase-js";
import { sha256Hex } from "@vula/core";
import type { Sql } from "@vula/db";
import { createTarReader, type TarReader } from "@vula/compellio";
import type { AppAuditRow, AuthAuditRow, VulaEvent } from "@vula/core";
import { AUDITED_TABLES, type ReconcileSource } from "./reconcile";
import type { BatchSource, Finding, LeafSource, PayloadSource, ProfileSource, StoredLeaf } from "./types";

export function dbLeafSource(sql: Sql): LeafSource {
  return {
    name: "vula.leaves (Supabase)",
    async getLeaves(): Promise<StoredLeaf[]> {
      const rows = await sql<{ index: number; leaf_hash: Buffer; event: unknown }[]>`
        select index, leaf_hash, event from vula.leaves order by index`;
      return rows.map((r) => ({ index: Number(r.index), leafHash: new Uint8Array(r.leaf_hash), event: r.event }));
    },
  };
}

export async function capturedEvents(sql: Sql): Promise<VulaEvent[]> {
  const rows = await sql<{ event: VulaEvent }[]>`select event from vula.leaves order by index`;
  return rows.map((r) => r.event);
}

export function dbPayloadSource(sql: Sql): PayloadSource {
  return {
    name: "vula.checkpoints (Supabase)",
    async getPayload(version) {
      const rows = await sql<{ payload: unknown }[]>`select payload from vula.checkpoints where seq = ${version}`;
      return rows[0]?.payload ?? null;
    },
  };
}

/** Follows the on-chain pointer: dataUri() -> the log server's /tar/0x{address} (all versions at one URL). */
export function dataUriPayloadSource(reader: TarReader): PayloadSource {
  let cache: Map<number, unknown> | null = null;
  let uri = "dataUri";
  return {
    get name() {
      return uri;
    },
    async getPayload(version) {
      if (!cache) {
        uri = await reader.dataUri(0);
        cache = new Map();
        try {
          const res = await fetch(uri, { signal: AbortSignal.timeout(20_000) });
          if (res.ok) {
            const body = (await res.json()) as { versions?: { version: number; payload: unknown }[] };
            for (const v of body.versions ?? []) cache.set(v.version, v.payload);
          }
        } catch {
          // unreachable payload host = missing payloads, reported by the verifier
        }
      }
      return cache.get(version) ?? null;
    },
  };
}

/**
 * The TAR profile (and its root schema) the checkpoints point to. Checksums come from the chain; the profile
 * payload comes from its own dataUri (the log server) or from vula.config, both untrusted.
 */
export function profileSource(rpcUrl: string, from: "datauri" | "db", sql?: Sql): ProfileSource {
  if (from === "db" && !sql) throw new Error("profile from vula.config needs a database connection");
  const readers = new Map<string, TarReader>();
  const chain = (tarId: string): TarReader => {
    let r = readers.get(tarId);
    if (!r) readers.set(tarId, (r = createTarReader({ rpcUrl, tarId })));
    return r;
  };
  return {
    name: from === "db" ? "vula.config (Supabase)" : "profile dataUri",
    chain,
    async getPayload(tarId, version) {
      if (from === "datauri") return dataUriPayloadSource(chain(tarId)).getPayload(version);
      const rows = await sql!<{ value: { tarId?: string; payload?: unknown } }[]>`select value from vula.config where key = 'profile'`;
      const p = rows[0]?.value;
      return p?.tarId === tarId && version === 0 ? (p.payload ?? null) : null;
    },
  };
}

/** Downloads batches from the private Supabase Storage bucket as the auditor Auth user. */
export function storageBatchSource(opts: { url: string; key: string; email: string; password: string }): BatchSource {
  const client = createClient(opts.url, opts.key, { auth: { persistSession: false } });
  let token: string | null = null;
  return {
    async getBatch(uri) {
      if (!token) {
        const { data, error } = await client.auth.signInWithPassword({ email: opts.email, password: opts.password });
        if (error || !data.session) return null;
        token = data.session.access_token;
      }
      const res = await fetch(uri, { headers: { authorization: `Bearer ${token}`, apikey: opts.key }, signal: AbortSignal.timeout(20_000) });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
}

export function dbReconcileSource(sql: Sql): ReconcileSource {
  return {
    appAuditRows: () => sql<AppAuditRow[]>`
      select id, occurred_at, table_name, op, row_pk, old_row, new_row, actor, db_user, txid
      from app_audit.events order by id`,
    authAuditRows: () => sql<AuthAuditRow[]>`
      select id, payload, created_at, ip_address from vula.auth_audit_entries(max_rows => 1000000)`,
    async tableRows(table) {
      if (!(AUDITED_TABLES as readonly string[]).includes(table)) throw new Error(`not an audited table: ${table}`);
      const rows = await sql.unsafe<{ row: Record<string, unknown> }[]>(`select to_jsonb(t) as row from ${table} t`);
      return rows.map((r) => r.row);
    },
    async labels() {
      const m = new Map<string, string>();
      for (const s of await sql<{ id: string; full_name: string }[]>`select id::text, full_name from app.students`) m.set(s.id, s.full_name);
      for (const c of await sql<{ id: string; code: string }[]>`select id::text, code from app.courses`) m.set(c.id, c.code);
      return m;
    },
  };
}

/** Writes critical/warning findings to vula.alerts (Realtime -> dashboard). De-duplicated per fingerprint. */
export async function reportFindings(sql: Sql, findings: Finding[], reporter: string): Promise<number> {
  let n = 0;
  for (const f of findings.filter((x) => x.severity !== "info")) {
    const fingerprint = sha256Hex(`${f.code}|${f.version ?? ""}|${f.index ?? ""}|${f.message}`).slice(0, 16);
    const dup = await sql`
      select 1 from vula.alerts where details ->> 'fingerprint' = ${fingerprint} and created_at > now() - interval '1 day' limit 1`;
    if (dup.length > 0) continue;
    await sql`
      insert into vula.alerts (kind, severity, title, details)
      values (${f.code}, ${f.severity}, ${f.message.slice(0, 500)},
              ${sql.json({ ...f.details, layer: f.layer, version: f.version ?? null, index: f.index ?? null, fingerprint, reporter } as never)})`;
    n++;
  }
  return n;
}
