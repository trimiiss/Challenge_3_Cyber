/**
 * Live check of the public TAR payload mirror (Supabase Storage bucket `vula-tar`):
 *   1. the log server's service user can upsert (twice: insert + update policies)
 *   2. anyone can read it back WITHOUT credentials at the public URL that DCAP_URI_PREFIX points to
 *   3. it is served as application/json with a short cache (max-age=10)
 * Writes only `vula-tar/_mirror-selftest.json` (no TAR data).  Usage: pnpm mirror:smoke
 */
import { loadEnv, requireEnv } from "@vula/db";
import { supabaseMirrorTarget } from "../apps/log-server/src/mirror";

loadEnv();
const target = supabaseMirrorTarget(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_PUBLISHABLE_KEY"),
  requireEnv("LOGSERVER_EMAIL"),
  requireEnv("LOGSERVER_PASSWORD"),
);
const path = "_mirror-selftest.json";
const url = `${target.publicPrefix}${path}`;
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
};

for (const round of [1, 2]) {
  const body = JSON.stringify({ selftest: true, round, at: new Date().toISOString() });
  await target.put(path, body);
  check(`upsert #${round} as the service user`, true);
  // cache-busting query: the CDN may still hold round 1 for up to 10 s
  const res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  check(`public read #${round} without credentials`, res.ok && text === body, `HTTP ${res.status}`);
  if (round === 2) {
    check("content-type application/json", /application\/json/.test(res.headers.get("content-type") ?? ""), res.headers.get("content-type") ?? "-");
    check("cache-control max-age=10", /max-age=10\b/.test(res.headers.get("cache-control") ?? ""), res.headers.get("cache-control") ?? "-");
  }
}
const anon = await fetch(`${target.publicPrefix}0x${"0".repeat(40)}`, { signal: AbortSignal.timeout(15_000) });
check("unknown TAR is not found (no listing, no error page as JSON)", !anon.ok, `HTTP ${anon.status}`);
console.log(`\nDCAP_URI_PREFIX for Shadownet: ${target.publicPrefix}`);
process.exitCode = failed ? 1 : 0;
