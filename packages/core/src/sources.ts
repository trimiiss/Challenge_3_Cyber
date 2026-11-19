import { makeEvent, type VulaEvent } from "./event";

/**
 * Mapping from source rows to Vula events. Shared by the collector (capture) and the verifier (reconcile),
 * so "captured row" and "current row" are always compared through the exact same function.
 */

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

// ------------------------------------------------------------ app_audit.events
export interface AppAuditRow {
  id: number;
  occurred_at: Date | string;
  table_name: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  row_pk: string | null;
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
  actor: string | null;
  db_user: string;
  txid: number;
}

export interface AppAuditData {
  id: number;
  occurredAt: string;
  table: string;
  op: string;
  rowPk: string | null;
  old: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
  actor: string | null;
  dbUser: string;
  txid: number;
}

export function appAuditData(row: AppAuditRow): AppAuditData {
  return {
    id: Number(row.id),
    occurredAt: iso(row.occurred_at),
    table: row.table_name,
    op: row.op,
    rowPk: row.row_pk,
    old: row.old_row,
    new: row.new_row,
    actor: row.actor,
    dbUser: row.db_user,
    txid: Number(row.txid),
  };
}

const ACTION_NOUN: Record<string, string> = {
  "app.grades": "grade",
  "app.roles": "role",
  "app.students": "student",
  "app.courses": "course",
  "app.logins": "login",
};

export function appAuditAction(table: string, op: string): string {
  const noun = ACTION_NOUN[table] ?? table;
  if (noun === "login") return op === "INSERT" ? "login" : `login.${op.toLowerCase()}`;
  if (noun === "role") return ({ INSERT: "role.grant", UPDATE: "role.update", DELETE: "role.revoke" } as Record<string, string>)[op]!;
  return `${noun}.${({ INSERT: "create", UPDATE: "update", DELETE: "delete" } as Record<string, string>)[op]}`;
}

export function appAuditEvent(row: AppAuditRow, seq: number, capturedAt: Date = new Date()): VulaEvent {
  const data = appAuditData(row);
  return makeEvent({
    source: "supabase.app_audit",
    sourceId: String(data.id),
    seq,
    occurredAt: data.occurredAt,
    capturedAt: capturedAt.toISOString(),
    actor: data.actor ?? `db:${data.dbUser}`,
    action: appAuditAction(data.table, data.op),
    target: `${data.table}:${data.rowPk ?? "?"}`,
    data,
  });
}

// ---------------------------------------------------- auth.audit_log_entries
export interface AuthAuditRow {
  id: string;
  payload: Record<string, unknown> | null;
  created_at: Date | string | null;
  ip_address: string;
}

export function authAuditData(row: AuthAuditRow) {
  return {
    id: row.id,
    createdAt: row.created_at ? iso(row.created_at) : null,
    ipAddress: row.ip_address,
    payload: row.payload,
  };
}

export function authAuditEvent(row: AuthAuditRow, seq: number, capturedAt: Date = new Date()): VulaEvent {
  const data = authAuditData(row);
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return makeEvent({
    source: "supabase.auth",
    sourceId: row.id,
    seq,
    occurredAt: data.createdAt ?? capturedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    actor: typeof p.actor_id === "string" ? p.actor_id : null,
    action: `auth.${typeof p.action === "string" ? p.action : "unknown"}`,
    target: typeof p.actor_username === "string" ? `auth.users:${p.actor_username}` : null,
    data,
  });
}

// ------------------------------------------------------------------- heartbeat
export function heartbeatEvent(
  collectorId: string,
  seq: number,
  info: Record<string, unknown>,
  now: Date = new Date(),
): VulaEvent {
  return makeEvent({
    source: "vula.heartbeat",
    sourceId: `${collectorId}:${seq}`,
    seq,
    occurredAt: now.toISOString(),
    capturedAt: now.toISOString(),
    actor: "vula.collector",
    action: "heartbeat",
    target: collectorId,
    data: { collector: collectorId, ...info },
  });
}

// ------------------------------------------------------------------------ diff
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Leaf-level JSON diff (paths like "new.grade"). Used to explain WHAT an attacker changed. */
export function diffJson(before: unknown, after: unknown, path = ""): FieldChange[] {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffJson(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((b, i) => diffJson(b, after[i], `${path}[${i}]`));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || "(root)", before, after }];
}
