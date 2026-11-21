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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<any> => (await fetch(`${BASE}${path}`, { headers: h })).json();
const ov = await get("/api/overview");
check("overview", typeof ov.counts?.leaves === "number", `${ov.counts?.leaves} events, TAR ${ov.tar?.tarId}, last anchored #${ov.lastAnchored?.seq}`);
const cps = await get("/api/checkpoints");
check("checkpoints", Array.isArray(cps) && cps.length > 0, `${cps.length} rows, latest #${cps[0]?.seq} ${cps[0]?.status}`);
const alerts = await get("/api/alerts");
check("alerts", Array.isArray(alerts), `${alerts.length} alerts, latest: ${alerts[0]?.kind ?? "-"}`);
const attacks = await get("/api/attack");
check("attack lab list (demo mode)", Array.isArray(attacks) && attacks.length === 8, attacks.map((a: { id: string }) => a.id).join(","));
const events = await get("/api/events?heartbeats=0");
check("live events", Array.isArray(events.events) && events.events.length > 0,
  `${events.events?.length} events, ${events.anchoredTreeSize} sealed, newest leaf #${events.events?.[0]?.index}`);
const sealed = events.events?.find((e: { sealedIn: unknown }) => e.sealedIn);
const proof = await (await fetch(`${BASE}/api/verify-event`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ id: String(sealed?.index ?? 0) }) })).json();
check("verify-event (inclusion proof vs chain)", proof.ok === true && proof.status === "included",
  `leaf ${proof.index}: ${proof.steps?.length} hashes -> TAR v${proof.anchor?.version}`);
for (const path of ["/", "/events", "/checkpoints", "/verify", "/alerts", "/attacks"]) {
  const page = await fetch(`${BASE}${path}`);
  check(`UI page ${path} renders`, page.ok && (await page.text()).includes("Vula"), `(${page.status})`);
}

console.log(failures === 0 ? "\nDashboard smoke ✅\n" : `\nDashboard smoke ❌ ${failures} failure(s)\n`);
process.exitCode = failures ? 1 : 0;
