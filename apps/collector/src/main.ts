/**
 * Vula collector: polls the source system every 10 s and ships events to the log server.
 *   supabase.app_audit  app_audit.events (trigger-written audit trail of app.*)
 *   supabase.auth       auth.audit_log_entries (Supabase Auth audit log, if written to the database)
 *   vula.heartbeat      one leaf every HEARTBEAT_INTERVAL_MS, so silence (a stopped collector) is detectable
 * A source's cursor only advances after the log server accepted the events (at-least-once; the log server
 * de-duplicates by source + sourceId).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appAuditEvent, authAuditEvent, heartbeatEvent, type AppAuditRow, type AuthAuditRow, type VulaEvent } from "@vula/core";
import { connect, loadEnv, requireEnv } from "@vula/db";

loadEnv();
const LOG_URL = (process.env.LOG_SERVER_URL || "http://localhost:4000").replace(/\/$/, "");
const TOKEN = requireEnv("VULA_INGEST_TOKEN");
const POLL_MS = Number(process.env.COLLECTOR_POLL_MS || 10_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 60_000);
const COLLECTOR_ID = process.env.COLLECTOR_ID || "collector-1";
const BATCH = 500;

const sql = connect("vula_log", { max: 2 });
const startedAt = Date.now();

// PID file so the "stop the collector" attack (attacks/08) can actually kill this process.
const pidFile = join(dirname(fileURLToPath(import.meta.url)), "../../../.run/collector.pid");
mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, String(process.pid));

interface AuditCursor { lastId: number; seq: number }
interface AuthCursor { createdAt: string; id: string; seq: number }
interface HeartbeatCursor { seq: number }

async function loadCursor<T>(source: string, init: T): Promise<T> {
  const rows = await sql<{ cursor: T }[]>`select cursor from vula.collector_state where source = ${source}`;
  return rows[0]?.cursor ?? init;
}

async function saveCursor(source: string, cursor: unknown): Promise<void> {
  await sql`
    insert into vula.collector_state (source, cursor) values (${source}, ${sql.json(cursor as never)})
    on conflict (source) do update set cursor = excluded.cursor, updated_at = now()`;
}

async function ship(events: VulaEvent[]): Promise<void> {
  if (events.length === 0) return;
  const res = await fetch(`${LOG_URL}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`log server rejected batch: HTTP ${res.status} ${await res.text()}`);
}

let audit = await loadCursor<AuditCursor>("supabase.app_audit", { lastId: 0, seq: 0 });
let auth = await loadCursor<AuthCursor>("supabase.auth", { createdAt: "1970-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000000", seq: 0 });
let hb = await loadCursor<HeartbeatCursor>("vula.heartbeat", { seq: 0 });

async function pollAppAudit(): Promise<number> {
  const rows = await sql<AppAuditRow[]>`
    select id, occurred_at, table_name, op, row_pk, old_row, new_row, actor, db_user, txid
    from app_audit.events where id > ${audit.lastId} order by id limit ${BATCH}`;
  if (rows.length === 0) return 0;
  const now = new Date();
  const events = rows.map((r, i) => appAuditEvent(r, audit.seq + i + 1, now));
  await ship(events);
  audit = { lastId: Number(rows.at(-1)!.id), seq: audit.seq + rows.length };
  await saveCursor("supabase.app_audit", audit);
  return rows.length;
}

async function pollAuth(): Promise<number> {
  const rows = await sql<AuthAuditRow[]>`
    select id, payload, created_at, ip_address
    from vula.auth_audit_entries(${auth.createdAt}::timestamptz, ${auth.id}::uuid, ${BATCH})`;
  if (rows.length === 0) return 0;
  const now = new Date();
  const events = rows.map((r, i) => authAuditEvent(r, auth.seq + i + 1, now));
  await ship(events);
  const last = rows.at(-1)!;
  auth = { createdAt: new Date(last.created_at!).toISOString(), id: last.id, seq: auth.seq + rows.length };
  await saveCursor("supabase.auth", auth);
  return rows.length;
}

async function heartbeat(): Promise<void> {
  const seq = hb.seq + 1;
  await ship([
    heartbeatEvent(COLLECTOR_ID, seq, {
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      cursors: { appAudit: audit.lastId, auth: auth.createdAt },
    }),
  ]);
  hb = { seq };
  await saveCursor("vula.heartbeat", hb);
}

// One job at a time keeps ordering simple.
let busy = false;
let lastHeartbeat = 0;
async function cycle(): Promise<void> {
  if (busy) return;
  busy = true;
  // Each source fails independently: a broken source must never silence the heartbeat (or vice versa).
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`[collector] ${name}: ${(e as Error).message}`);
    }
  };
  try {
    await step("app_audit", async () => {
      let n = 0;
      do n = await pollAppAudit(); while (n === BATCH);
    });
    await step("auth", async () => {
      const a = await pollAuth();
      if (a) console.log(`[collector] +${a} auth events`);
    });
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      await step("heartbeat", async () => {
        await heartbeat();
        lastHeartbeat = Date.now();
      });
    }
  } finally {
    busy = false;
  }
}

console.log(`[collector] ${COLLECTOR_ID} -> ${LOG_URL}  poll ${POLL_MS / 1000} s, heartbeat ${HEARTBEAT_MS / 1000} s, cursors: audit ${audit.lastId}, heartbeat ${hb.seq}`);
await cycle();
const timer = setInterval(() => void cycle(), Math.min(POLL_MS, HEARTBEAT_MS));
let shipped = audit.seq;
setInterval(() => {
  if (audit.seq !== shipped) console.log(`[collector] app_audit cursor ${audit.lastId} (+${audit.seq - shipped})`);
  shipped = audit.seq;
}, POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    rmSync(pidFile, { force: true });
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
