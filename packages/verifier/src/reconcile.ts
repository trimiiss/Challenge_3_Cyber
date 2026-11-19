import {
  appAuditData,
  authAuditData,
  diffJson,
  jcs,
  type AppAuditData,
  type AppAuditRow,
  type AuthAuditRow,
  type VulaEvent,
} from "@vula/core";
import type { Finding, ReconcileReport } from "./types";

/** Current state of the source system (Supabase), read with a read-only role. Untrusted. */
export interface ReconcileSource {
  appAuditRows(): Promise<AppAuditRow[]>;
  authAuditRows(): Promise<AuthAuditRow[]>;
  /** Current rows of an audited table as to_jsonb(row), i.e. the same JSON shape the audit trigger stores. */
  tableRows(table: string): Promise<Record<string, unknown>[]>;
  /** Human labels for ids (student / course / user names) to make findings readable. */
  labels(): Promise<Map<string, string>>;
}

export const AUDITED_TABLES = ["app.grades", "app.roles", "app.students", "app.courses", "app.logins"] as const;

const LAYER = "source-vs-log" as const;
const pkOf = (row: Record<string, unknown> | null | undefined) => String(row?.id ?? row?.user_id ?? "?");

/**
 * `vula reconcile` (CLAUDE.md §7.5): compares the events Vula captured with the source system today.
 *   deleted_audit_row     captured audit record no longer exists in app_audit.events
 *   modified_audit_row    it exists but its content differs from what was captured
 *   unexplained_audit_row an audit record Vula never saw although the collector has passed it (inserted out of band)
 *   unexplained_change    a table row differs from its last audited state and no audit record explains it
 *   unexplained_row / unexplained_delete  rows appearing / disappearing without an audit record
 *   deleted_auth_entry / modified_auth_entry  same checks for auth.audit_log_entries
 *
 * The captured events are only meaningful once `verify-log` has proven them against the chain.
 */
export async function reconcile(captured: VulaEvent[], source: ReconcileSource): Promise<ReconcileReport> {
  const findings: Finding[] = [];
  const labels = await source.labels();
  const name = (id: unknown) => labels.get(String(id)) ?? String(id).slice(0, 8);
  const describeRow = (table: string, row: Record<string, unknown> | null | undefined): string => {
    if (!row) return table;
    if (table === "app.grades") return `grade of ${name(row.student_id)} in ${name(row.course_id)}`;
    if (table === "app.roles") return `role of ${name(row.user_id)}`;
    if (table === "app.students") return `student ${row.full_name ?? pkOf(row)}`;
    if (table === "app.courses") return `course ${row.code ?? pkOf(row)}`;
    return `${table}:${pkOf(row)}`;
  };

  // ------------------------------------------------ audit records: captured vs current
  const capturedAudit = captured
    .filter((e) => e.source === "supabase.app_audit")
    .map((e) => e.data as AppAuditData)
    .sort((a, b) => a.id - b.id);
  const currentAudit = new Map((await source.appAuditRows()).map((r) => [Number(r.id), r]));
  const maxCaptured = capturedAudit.at(-1)?.id ?? 0;
  const capturedIds = new Set(capturedAudit.map((d) => d.id));

  for (const cap of capturedAudit) {
    const row = cur(cap, currentAudit);
    const what = `${cap.op} on ${describeRow(cap.table, cap.new ?? cap.old)}`;
    if (!row) {
      findings.push({
        code: "deleted_audit_row", severity: "critical", layer: LAYER,
        message: `Audit record #${cap.id} (${what}, ${cap.occurredAt}) was DELETED from app_audit.events`,
        details: { auditId: cap.id, captured: cap },
      });
      continue;
    }
    const now = appAuditData(row);
    if (jcs(now) !== jcs(cap)) {
      findings.push({
        code: "modified_audit_row", severity: "critical", layer: LAYER,
        message: `Audit record #${cap.id} (${what}) was MODIFIED after capture`,
        details: { auditId: cap.id, changes: diffJson(cap, now) },
      });
    }
  }
  let pending = 0;
  const pendingPks = new Set<string>();
  for (const [id, row] of currentAudit) {
    if (id > maxCaptured) {
      pending++;
      pendingPks.add(`${row.table_name}|${row.row_pk}`);
    } else if (!capturedIds.has(id)) {
      findings.push({
        code: "unexplained_audit_row", severity: "critical", layer: LAYER,
        message: `Audit record #${id} (${row.op} ${row.table_name}) exists but was never captured: inserted out of band or backdated`,
        details: { auditId: id, row: appAuditData(row) },
      });
    }
  }

  // ------------------------------------------------ table state: replay captured audit -> expected rows
  for (const table of AUDITED_TABLES) {
    const expected = new Map<string, Record<string, unknown>>();
    for (const cap of capturedAudit.filter((c) => c.table === table)) {
      const pk = cap.rowPk ?? pkOf(cap.new ?? cap.old);
      if (cap.op === "DELETE") expected.delete(pk);
      else if (cap.new) expected.set(pk, cap.new);
    }
    const rows = await source.tableRows(table);
    const seen = new Set<string>();
    for (const row of rows) {
      const pk = pkOf(row);
      seen.add(pk);
      if (pendingPks.has(`${table}|${pk}`)) continue; // a newer audit record exists, just not collected yet
      const exp = expected.get(pk);
      if (!exp) {
        findings.push({
          code: "unexplained_row", severity: "critical", layer: LAYER,
          message: `${describeRow(table, row)} exists in ${table} but no audited INSERT explains it`,
          details: { table, pk, row },
        });
      } else if (jcs(exp) !== jcs(row)) {
        const changes = diffJson(exp, row);
        const gradeChange = table === "app.grades" ? changes.find((c) => c.path === "grade") : undefined;
        findings.push({
          code: "unexplained_change", severity: "critical", layer: LAYER,
          message: gradeChange
            ? `${describeRow(table, row)} is ${String(gradeChange.after)} but the last audited value is ${String(gradeChange.before)}: no audit record explains the change`
            : `${describeRow(table, row)} differs from its last audited state: no audit record explains the change`,
          details: { table, pk, changes },
        });
      }
    }
    for (const [pk, exp] of expected) {
      if (!seen.has(pk) && !pendingPks.has(`${table}|${pk}`)) {
        findings.push({
          code: "unexplained_delete", severity: "critical", layer: LAYER,
          message: `${describeRow(table, exp)} disappeared from ${table} without an audited DELETE`,
          details: { table, pk, lastAudited: exp },
        });
      }
    }
  }

  // ------------------------------------------------ Supabase Auth audit log
  const capturedAuth = captured.filter((e) => e.source === "supabase.auth");
  const currentAuth = new Map((await source.authAuditRows()).map((r) => [r.id, r]));
  for (const e of capturedAuth) {
    const row = currentAuth.get(e.sourceId);
    if (!row) {
      findings.push({
        code: "deleted_auth_entry", severity: "critical", layer: LAYER,
        message: `Auth audit entry ${e.sourceId} (${e.action} ${e.target ?? ""}, ${e.occurredAt}) was DELETED from auth.audit_log_entries`,
        details: { captured: e.data },
      });
    } else if (jcs(authAuditData(row)) !== jcs(e.data)) {
      findings.push({
        code: "modified_auth_entry", severity: "critical", layer: LAYER,
        message: `Auth audit entry ${e.sourceId} (${e.action}) was MODIFIED after capture`,
        details: { changes: diffJson(e.data, authAuditData(row)) },
      });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === "critical"),
    capturedEvents: capturedAudit.length + capturedAuth.length,
    sourceRows: currentAudit.size + currentAuth.size,
    pendingRows: pending,
    findings,
  };
}

function cur(cap: AppAuditData, current: Map<number, AppAuditRow>): AppAuditRow | undefined {
  return current.get(cap.id);
}
