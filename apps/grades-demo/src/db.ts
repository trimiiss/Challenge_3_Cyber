import { createClient } from "@supabase/supabase-js";
import { connect, loadEnv, requireEnv, type Sql } from "@vula/db";

loadEnv();

export const sql: Sql = connect("uibm_app", { max: 3 });
export const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_PUBLISHABLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Professor {
  id: string;
  email: string;
  name: string;
}

/** Signs in with Supabase Auth. Returns the access token (kept in an httpOnly cookie). */
export async function login(email: string, password: string): Promise<{ token: string; user: Professor }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(error?.message ?? "login failed");
  const user = toProfessor(data.user);
  await asUser(user.id, (tx) => tx`insert into app.logins (user_id, user_agent) values (${user.id}, 'uibm-grades-demo')`);
  return { token: data.session.access_token, user };
}

export async function userFromToken(token: string | undefined): Promise<Professor | null> {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : toProfessor(data.user);
}

function toProfessor(u: { id: string; email?: string; user_metadata?: Record<string, unknown> }): Professor {
  return { id: u.id, email: u.email ?? "", name: String(u.user_metadata?.full_name ?? u.email) };
}

/**
 * Runs writes as the signed-in app user: sets request.jwt.claims for the transaction (exactly what PostgREST
 * does), so the audit trigger records auth.uid() = the professor as the actor.
 */
export async function asUser<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

export interface CourseView {
  id: string;
  code: string;
  title: string;
  rows: { studentId: string; studentNo: string; name: string; grade: number | null; updatedAt: Date | null }[];
}

export async function coursesOf(professorId: string): Promise<CourseView[]> {
  const courses = await sql<{ id: string; code: string; title: string }[]>`
    select id, code, title from app.courses where professor_id = ${professorId} order by code`;
  const out: CourseView[] = [];
  for (const c of courses) {
    const rows = await sql<{ student_id: string; student_no: string; full_name: string; grade: number | null; updated_at: Date | null }[]>`
      select s.id as student_id, s.student_no, s.full_name, g.grade, g.updated_at
      from app.students s left join app.grades g on g.student_id = s.id and g.course_id = ${c.id}
      order by s.student_no`;
    out.push({
      ...c,
      rows: rows.map((r) => ({ studentId: r.student_id, studentNo: r.student_no, name: r.full_name, grade: r.grade, updatedAt: r.updated_at })),
    });
  }
  return out;
}

export async function setGrade(professorId: string, courseId: string, studentId: string, grade: number): Promise<void> {
  if (!Number.isInteger(grade) || grade < 5 || grade > 10) throw new Error("grade must be 5..10");
  await asUser(professorId, async (tx) => {
    const own = await tx`select 1 from app.courses where id = ${courseId} and professor_id = ${professorId}`;
    if (own.length === 0) throw new Error("not your course");
    await tx`
      insert into app.grades (student_id, course_id, grade, updated_by, updated_at)
      values (${studentId}, ${courseId}, ${grade}, ${professorId}, now())
      on conflict (student_id, course_id)
      do update set grade = excluded.grade, updated_by = excluded.updated_by, updated_at = now()
      where app.grades.grade is distinct from excluded.grade`;
  });
}
