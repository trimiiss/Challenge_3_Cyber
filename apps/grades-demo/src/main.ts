/** UIBM Grades: the tiny demo app whose audit trail Vula protects. All data synthetic. */
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { coursesOf, login, setGrade, userFromToken, type CourseView, type Professor } from "./db";

const PORT = Number(process.env.GRADES_PORT || 3001);
const app = Fastify({ logger: false });
await app.register(formbody);

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cookie = (h: string | undefined, name: string) =>
  h?.split(";").map((p) => p.trim().split("=")).find(([k]) => k === name)?.[1];

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14213d;--muted:#5c677d;--line:#e3e6ec;--brand:#8a1c2b;--ok:#1b7f4b}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--brand);color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
header b{font-size:18px;letter-spacing:.3px}header form{margin:0}header button{background:transparent;border:1px solid #fff8;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer}
main{max-width:980px;margin:24px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:20px}
h2{margin:0 0 4px;font-size:18px}.muted{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;color:var(--muted)}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px}button.save{background:var(--brand);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
.grade{font-weight:600}.fail{color:#b42318}.login{max-width:380px;margin:80px auto}.login input{width:100%;margin:6px 0 12px}.login button{width:100%;padding:10px;background:var(--brand);color:#fff;border:0;border-radius:6px}
.err{color:#b42318}.flash{background:#e8f5ee;color:var(--ok);padding:8px 12px;border-radius:6px;margin-bottom:16px}
</style></head><body>${body}</body></html>`;
}

function loginPage(error?: string): string {
  return page("UIBM Grades: sign in", `<div class="card login"><h2>UIBM Grades</h2><p class="muted">University "Isa Boletini" Mitrovicë (demo, synthetic data)</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login"><label>Email<input name="email" type="email" value="prof.krasniqi@uibm.test" required></label>
<label>Password<input name="password" type="password" required></label><button>Sign in</button></form></div>`);
}

function gradesPage(user: Professor, courses: CourseView[], flash?: string): string {
  const course = (c: CourseView) => `<div class="card"><h2>${esc(c.code)}: ${esc(c.title)}</h2>
<p class="muted">${c.rows.filter((r) => r.grade !== null).length} of ${c.rows.length} graded</p>
<table><tr><th>Student no.</th><th>Name</th><th>Grade</th><th>Set grade</th></tr>
${c.rows.map((r) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.name)}</td>
<td class="grade ${r.grade === 5 ? "fail" : ""}">${r.grade ?? "–"}</td>
<td><form method="post" action="/grade" style="display:flex;gap:6px"><input type="hidden" name="course" value="${esc(c.id)}"><input type="hidden" name="student" value="${esc(r.studentId)}">
<select name="grade">${[5, 6, 7, 8, 9, 10].map((g) => `<option${g === (r.grade ?? 6) ? " selected" : ""}>${g}</option>`).join("")}</select><button class="save">Save</button></form></td></tr>`).join("")}
</table></div>`;
  return page("UIBM Grades", `<header><b>UIBM Grades</b><span>${esc(user.name)} <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></span></header>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ""}${courses.map(course).join("")}
<p class="muted">Every change is written to the audit trail and sealed by Vula.</p></main>`);
}

app.get("/", async (req, reply) => {
  const user = await userFromToken(cookie(req.headers.cookie, "uibm_token"));
  reply.type("text/html");
  if (!user) return loginPage();
  const flash = (req.query as Record<string, string>).saved;
  return gradesPage(user, await coursesOf(user.id), flash ? `Saved: ${flash}` : undefined);
});

app.post("/login", async (req, reply) => {
  const { email, password } = req.body as Record<string, string>;
  try {
    const { token } = await login(email ?? "", password ?? "");
    reply.header("set-cookie", `uibm_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`).redirect("/");
  } catch (e) {
    reply.type("text/html").code(401).send(loginPage((e as Error).message));
  }
});

app.post("/logout", async (_req, reply) => {
  reply.header("set-cookie", "uibm_token=; HttpOnly; Path=/; Max-Age=0").redirect("/");
});

app.post("/grade", async (req, reply) => {
  const user = await userFromToken(cookie(req.headers.cookie, "uibm_token"));
  if (!user) return reply.redirect("/");
  const { course, student, grade } = req.body as Record<string, string>;
  await setGrade(user.id, course!, student!, Number(grade));
  reply.redirect(`/?saved=${encodeURIComponent(`grade ${grade}`)}`);
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[grades-demo] UIBM Grades on http://localhost:${PORT}`);
