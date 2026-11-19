/**
 * Insider attacks for the demo (CLAUDE.md §7.6). The attacker is `uibm_admin`: a DBA with full rights on the app,
 * audit and Vula tables, i.e. what someone holding the postgres password can do to these tables.
 * Each attack returns a description of what it did; the README lists the expected verifier output.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { eventLeafHash, makeEvent, type VulaEvent } from "@vula/core";
import { connect, loadEnv, type Sql } from "@vula/db";
import { toHex } from "@vula/merkle";

loadEnv();

export interface Attack {
  id: string;
  title: string;
  story: string;
  detectedBy: "vula reconcile" | "vula verify-log" | "log-server watchdog";
  expected: string;
  run(sql: Sql): Promise<string>;
}

let insider: Sql | null = null;
export function insiderDb(): Sql {
  insider ??= connect("uibm_admin", { max: 2 });
  return insider;
}
export async function closeInsiderDb(): Promise<void> {
  await insider?.end({ timeout: 5 });
  insider = null;
}

interface GradeTarget { id: string; grade: number; student: string; course: string }

/** The victim grade: Driton Shala's CS205 grade if entered in the demo, otherwise his CS101 grade (seed: 6). */
async function targetGrade(sql: Sql): Promise<GradeTarget> {
  const rows = await sql<GradeTarget[]>`
    select g.id::text, g.grade, s.full_name as student, c.code as course
    from app.grades g join app.students s on s.id = g.student_id join app.courses c on c.id = g.course_id
    where s.student_no = 'UIBM-2026-004'
    order by (c.code = 'CS205') desc, c.code limit 1`;
  if (!rows[0]) throw new Error("no grade for Driton Shala (UIBM-2026-004) yet");
  return rows[0];
}

/** Highest audit id the collector has already shipped to Vula (so the tampering is of captured evidence). */
async function capturedAuditCursor(sql: Sql): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    select coalesce((cursor ->> 'lastId')::bigint, 0) as id from vula.collector_state where source = 'supabase.app_audit'`;
  return Number(rows[0]?.id ?? 0);
}

export const ATTACKS: Attack[] = [
  {
    id: "1",
    title: "Delete an audit record",
    story: "The insider deletes the audit record of the latest grade change from app_audit.events.",
    detectedBy: "vula reconcile",
    expected: "❌ [deleted_audit_row] Audit record #N (… grade …) was DELETED from app_audit.events",
    async run(sql) {
      const cursor = await capturedAuditCursor(sql);
      const rows = await sql<{ id: number; op: string }[]>`
        delete from app_audit.events
        where id = (select max(id) from app_audit.events where table_name = 'app.grades' and id <= ${cursor})
        returning id, op`;
      if (!rows[0]) throw new Error("no captured grade audit record to delete yet");
      return `deleted app_audit.events #${rows[0].id} (${rows[0].op} on app.grades)`;
    },
  },
  {
    id: "2",
    title: "Change a grade and rewrite its audit record",
    story:
      "The insider raises Driton Shala's grade to 10, deletes the audit row the trigger just wrote (same transaction, " +
      "so no collector ever sees it) and edits the earlier audit record so it already shows 10.",
    detectedBy: "vula reconcile",
    expected:
      "❌ [modified_audit_row] Audit record #N (…) was MODIFIED after capture\n" +
      "❌ [unexplained_change] grade of Driton Shala in CS205 is 10 but the last audited value is 6",
    async run(sql) {
      const t = await targetGrade(sql);
      const newGrade = t.grade === 10 ? 9 : 10;
      const cursor = await capturedAuditCursor(sql);
      let edited = 0;
      await sql.begin(async (tx) => {
        await tx`update app.grades set grade = ${newGrade}, updated_at = now() where id = ${t.id}`;
        await tx`delete from app_audit.events where txid = txid_current()`;
        const r = await tx`
          update app_audit.events
          set new_row = jsonb_set(new_row, '{grade}', to_jsonb(${newGrade}::int))
          where id = (select max(id) from app_audit.events where row_pk = ${t.id} and id <= ${cursor} and new_row is not null)
          returning id`;
        edited = r.count;
      });
      return `set ${t.student}'s ${t.course} grade ${t.grade} -> ${newGrade}, removed the trigger's audit row, rewrote ${edited} earlier audit record(s)`;
    },
  },
  {
    id: "4",
    title: "Edit a leaf in Vula's own log",
    story:
      "The insider also edits Vula's stored copy (vula.leaves) of the grade event so it shows 10, and recomputes " +
      "dataSha256 and leaf_hash so the row looks self-consistent.",
    detectedBy: "vula verify-log",
    expected:
      "❌ [root_mismatch] Stored leaves no longer reproduce the root anchored in TAR version V …\n" +
      "❌ [leaf_altered] Leaf I was ALTERED: grade.update app.grades:… (grade 6 -> …)\n" +
      "        data.new.grade: 6 → 10",
    async run(sql) {
      const rows = await sql<{ index: number; event: VulaEvent }[]>`
        select index, event from vula.leaves
        where event ->> 'action' in ('grade.create', 'grade.update')
          and index < (select coalesce(max(tree_size), 0) from vula.checkpoints where status = 'anchored')
        order by index desc limit 1`;
      const row = rows[0];
      if (!row) throw new Error("no anchored grade event in vula.leaves yet");
      const data = structuredClone(row.event.data) as { new: { grade: number } };
      const before = data.new.grade;
      data.new.grade = before === 10 ? 9 : 10;
      const { v: _v, dataSha256: _d, ...rest } = row.event;
      const forged = makeEvent({ ...rest, data });
      await sql`
        update vula.leaves set event = ${sql.json(forged as never)}, leaf_hash = ${Buffer.from(eventLeafHash(forged))}
        where index = ${row.index}`;
      return `rewrote leaf ${row.index} (${row.event.action} ${row.event.target}): grade ${before} -> ${data.new.grade}, leaf_hash -> ${toHex(eventLeafHash(forged)).slice(0, 16)}…`;
    },
  },
  {
    id: "5",
    title: "Truncate the log (delete the newest leaves)",
    story: "The insider deletes the newest 5 anchored leaves from vula.leaves to make recent events disappear.",
    detectedBy: "vula verify-log",
    expected: "❌ [log_truncated] Log truncated: vula.leaves has N leaves but TAR version V anchored M\n❌ [leaf_deleted] Leaf … was DELETED from the log",
    async run(sql) {
      const rows = await sql<{ size: number }[]>`
        select coalesce(max(tree_size), 0)::int as size from vula.checkpoints where status = 'anchored'`;
      const size = rows[0]?.size ?? 0;
      if (size < 6) throw new Error("need at least 6 anchored leaves");
      const r = await sql`delete from vula.leaves where index >= ${size - 5}`;
      return `deleted ${r.count} leaves (index >= ${size - 5}) from vula.leaves`;
    },
  },
  {
    id: "8",
    title: "Stop the collector (silence)",
    story: "The insider stops the Vula collector before doing something, hoping nobody notices the gap.",
    detectedBy: "log-server watchdog",
    expected: "❌ [heartbeat_gap] No collector heartbeat for N s   (dashboard alert after HEARTBEAT_GAP_MS)",
    async run() {
      const pidFile = join(dirname(fileURLToPath(import.meta.url)), "../../.run/collector.pid");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        try {
          if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          else process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
        rmSync(pidFile, { force: true });
        return `killed collector process ${pid}; heartbeat alert expected within ${Number(process.env.HEARTBEAT_GAP_MS || 150000) / 1000} s`;
      }
      try {
        execSync("docker compose -f infra/docker-compose.yml stop collector", { stdio: "ignore" });
        return "stopped the collector container";
      } catch {
        throw new Error("collector is not running (no .run/collector.pid and no compose service)");
      }
    },
  },
];

export function findAttack(id: string): Attack {
  const a = ATTACKS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown attack ${id}; available: ${ATTACKS.map((x) => x.id).join(", ")}`);
  return a;
}
