import type { Sql } from "@vula/db";

/**
 * Resets the demo to a fresh state: empty Vula log (a NEW TAR is created at the next checkpoint), empty alerts,
 * re-seeded app data (so its INSERT audit records exist again). Run with log server + collector STOPPED.
 */
export async function resetDemo(sql: Sql): Promise<string> {
  await sql.begin(async (tx) => {
    const roles = await tx<{ user_id: string; role: string }[]>`select user_id::text, role from app.roles`;
    const owners = await tx<{ code: string; professor_id: string }[]>`select code, professor_id::text from app.courses`;
    const courseOwner = new Map(owners.map((o) => [o.code, o.professor_id]));
    if (!courseOwner.get("CS101") || !courseOwner.get("CS310")) throw new Error("courses missing: run supabase/seed.sql first");

    await tx`truncate vula.leaves, vula.checkpoints, vula.collector_state, vula.alerts, vula.config`;
    await tx`delete from app.grades`;
    await tx`delete from app.logins`;
    await tx`delete from app.courses`;
    await tx`delete from app.students`;
    await tx`delete from app.roles`;
    await tx`truncate app_audit.events`; // ids keep counting; the collector cursor restarts at 0

    // Re-create everything so the audit trail starts complete (every row has its audited INSERT).
    for (const r of roles) await tx`insert into app.roles (user_id, role) values (${r.user_id}, ${r.role})`;
    const k = courseOwner.get("CS101")!;
    const g = courseOwner.get("CS310")!;
    await tx`insert into app.courses (code, title, professor_id) values
      ('CS101', 'Programming I', ${k}), ('CS205', 'Databases', ${k}), ('CS310', 'Computer Networks', ${g})`;
    await tx`insert into app.students (student_no, full_name) values
      ('UIBM-2026-001', 'Arta Hoxha'), ('UIBM-2026-002', 'Blerim Morina'), ('UIBM-2026-003', 'Dafina Berisha'),
      ('UIBM-2026-004', 'Driton Shala'), ('UIBM-2026-005', 'Elira Kelmendi'), ('UIBM-2026-006', 'Fatlind Rexhepi'),
      ('UIBM-2026-007', 'Gentiana Bytyqi'), ('UIBM-2026-008', 'Ilir Mustafa'), ('UIBM-2026-009', 'Jeta Rama'),
      ('UIBM-2026-010', 'Kushtrim Hajdari'), ('UIBM-2026-011', 'Lirie Zeka'), ('UIBM-2026-012', 'Mentor Ahmeti')`;
    await tx`
      insert into app.grades (student_id, course_id, grade, updated_by)
      select s.id, c.id, v.grade, c.professor_id
      from (values ('UIBM-2026-001','CS101',9), ('UIBM-2026-002','CS101',7), ('UIBM-2026-003','CS101',10),
                   ('UIBM-2026-004','CS101',6), ('UIBM-2026-005','CS101',8), ('UIBM-2026-006','CS101',5),
                   ('UIBM-2026-007','CS101',9), ('UIBM-2026-008','CS101',7), ('UIBM-2026-009','CS310',8),
                   ('UIBM-2026-010','CS310',6), ('UIBM-2026-011','CS310',9), ('UIBM-2026-012','CS310',7)) as v(no, code, grade)
      join app.students s on s.student_no = v.no join app.courses c on c.code = v.code`;
  });
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from app_audit.events`;
  return `demo reset: Vula log emptied (next checkpoint creates a new TAR), app data re-seeded (${rows[0]?.n ?? 0} audit records)`;
}
