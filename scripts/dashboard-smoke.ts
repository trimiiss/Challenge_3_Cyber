/** Smoke test of the running dashboard API: auth gate + every route. `pnpm dashboard:smoke` */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "@vula/db";

loadEnv();
const BASE = process.env.DASHBOARD_URL || "http://localhost:3000";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name} ${detail}`);
  if (!ok) failures++;
};

const anon = await fetch(`${BASE}/api/overview`);
check("no session → 401", anon.status === 401, `(${anon.status})`);

const prof = await sb.auth.signInWithPassword({ email: process.env.PROF_EMAIL!, password: process.env.PROF_PASSWORD! });
const asProf = await fetch(`${BASE}/api/alerts`, { headers: { authorization: `Bearer ${prof.data.session?.access_token}` } });
check("professor (not auditor) → 403", asProf.status === 403, `(${asProf.status})`);

const { data, error } = await sb.auth.signInWithPassword({ email: process.env.AUDITOR_EMAIL!, password: process.env.AUDITOR_PASSWORD! });
if (error || !data.session) throw new Error(`auditor sign-in failed: ${error?.message}`);
const h = { authorization: `Bearer ${data.session.access_token}` };

const ov = await (await fetch(`${BASE}/api/overview`, { headers: h })).json();
check("overview", typeof ov.counts?.leaves === "number", `${ov.counts?.leaves} events, TAR ${ov.tar?.tarId}, last anchored #${ov.lastAnchored?.seq}`);
const cps = await (await fetch(`${BASE}/api/checkpoints`, { headers: h })).json();
check("checkpoints", Array.isArray(cps) && cps.length > 0, `${cps.length} rows, latest #${cps[0]?.seq} ${cps[0]?.status}`);
const alerts = await (await fetch(`${BASE}/api/alerts`, { headers: h })).json();
check("alerts", Array.isArray(alerts), `${alerts.length} alerts, latest: ${alerts[0]?.kind ?? "-"}`);
const attacks = await (await fetch(`${BASE}/api/attack`, { headers: h })).json();
check("attack lab list (demo mode)", Array.isArray(attacks) && attacks.length === 5, attacks.map((a: { id: string }) => a.id).join(","));
const page = await fetch(`${BASE}/`);
check("UI page renders", page.ok && (await page.text()).includes("Vula"), `(${page.status})`);

console.log(failures === 0 ? "\nDashboard smoke ✅\n" : `\nDashboard smoke ❌ ${failures} failure(s)\n`);
process.exitCode = failures ? 1 : 0;
