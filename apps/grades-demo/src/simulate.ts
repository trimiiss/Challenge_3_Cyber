/**
 * Background activity for the demo/testnet run: the professor logs in and enters CS205 grades now and then.
 *   pnpm --filter @vula/grades-demo simulate [--every 90] [--count 0]
 */
import { coursesOf, login, setGrade, sql } from "./db";

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const every = arg("every", 90) * 1000;
const count = arg("count", 0); // 0 = forever

const { user } = await login(process.env.PROF_EMAIL!, process.env.PROF_PASSWORD!);
console.log(`[simulate] signed in as ${user.name}; a grade change every ${every / 1000} s`);
for (let n = 1; count === 0 || n <= count; n++) {
  const courses = await coursesOf(user.id);
  const c = courses[Math.floor(Math.random() * courses.length)]!;
  const r = c.rows[Math.floor(Math.random() * c.rows.length)]!;
  const grade = 6 + Math.floor(Math.random() * 5);
  await setGrade(user.id, c.id, r.studentId, grade);
  console.log(`[simulate] #${n} ${c.code} ${r.name}: ${r.grade ?? "–"} -> ${grade}`);
  if (count === 0 || n < count) await new Promise((res) => setTimeout(res, every));
}
await sql.end();
