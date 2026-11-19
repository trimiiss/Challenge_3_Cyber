/**
 * Proves the demo's key moment end to end: "Run attack" button -> verifier -> vula.alerts -> Supabase Realtime -> browser.
 *   pnpm realtime:smoke [attackId=2]
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "@vula/db";

loadEnv();
const BASE = process.env.DASHBOARD_URL || "http://localhost:3000";
const attackId = process.argv[2] ?? "2";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email: process.env.AUDITOR_EMAIL!, password: process.env.AUDITOR_PASSWORD! });
if (error || !data.session) throw new Error(`auditor sign-in failed: ${error?.message}`);

const received: { kind: string; title: string; at: number }[] = [];
const t0 = Date.now();
await new Promise<void>((resolve, reject) => {
  sb.channel("realtime-smoke")
    .on("postgres_changes", { event: "INSERT", schema: "vula", table: "alerts" }, (p) => {
      const row = p.new as { kind: string; title: string };
      received.push({ ...row, at: Date.now() - t0 });
      console.log(`  ⚡ realtime alert after ${Date.now() - t0} ms: [${row.kind}] ${row.title}`);
    })
    .subscribe((status) => (status === "SUBSCRIBED" ? resolve() : status === "CHANNEL_ERROR" ? reject(new Error(status)) : undefined));
});
console.log(`subscribed to vula.alerts as ${data.user.email}; pressing "Run attack ${attackId}" ...`);

const res = await fetch(`${BASE}/api/attack`, {
  method: "POST",
  headers: { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" },
  body: JSON.stringify({ id: attackId }),
});
const body = (await res.json()) as { done?: string; ok?: boolean; findings?: { code: string }[]; error?: string };
console.log(`  attack: ${body.done ?? body.error}`);
console.log(`  verifier: ${body.ok === false ? "❌ tampering detected" : body.ok ? "✅ clean" : "pending"} ${(body.findings ?? []).map((f) => f.code).join(", ")}`);

for (let i = 0; i < 20 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 500));
console.log(received.length > 0 ? `\nRealtime smoke ✅ ${received.length} alert(s) pushed to the browser channel\n` : "\nRealtime smoke ❌ no alert arrived\n");
process.exitCode = received.length > 0 ? 0 : 1;
await sb.removeAllChannels();
