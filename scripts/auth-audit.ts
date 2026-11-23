/**
 * Supabase setting "Write Auth audit logs to the database" (needed for attack 3: auth.audit_log_entries).
 *   pnpm auth-audit status
 *   pnpm auth-audit on|off   tries the Management API, then re-reads the value to check it really changed
 * Needs SUPABASE_ACCESS_TOKEN (personal access token, https://supabase.com/dashboard/account/tokens) and
 * SUPABASE_PROJECT_REF, from the environment or the gitignored .env. The token is never printed.
 *
 * Tested 2026-11-23: the v1 API returns `audit_log_disable_postgres` but ignores it on PATCH (it isn't in the
 * OpenAPI schema), and the dashboard's own /platform endpoint rejects personal access tokens. So today `on|off`
 * only reports what to click; `status` works.
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF (environment or .env) first.");
  process.exit(2);
}

const URL = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const FIELD = "audit_log_disable_postgres";
const DASHBOARD = `https://supabase.com/dashboard/project/${ref}/auth/audit-logs`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function request(method: "GET" | "PATCH", body?: object): Promise<boolean> {
  const res = await fetch(URL, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} config/auth -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const disabled = ((await res.json()) as Record<string, unknown>)[FIELD];
  if (typeof disabled !== "boolean") throw new Error(`config/auth has no ${FIELD} field`);
  return disabled;
}

const show = (disabled: boolean) =>
  console.log(`Write Auth audit logs to the database: ${disabled ? "OFF" : "ON"} (project ${ref})`);

const cmd = process.argv[2] ?? "status";
try {
  if (cmd === "status") show(await request("GET"));
  else if (cmd === "on" || cmd === "off") {
    const want = cmd === "off";
    await request("PATCH", { [FIELD]: want });
    const now = await request("GET");
    show(now);
    if (now !== want) {
      console.error(`The API did not apply it. Flip "Write audit logs to the database" here and save:\n  ${DASHBOARD}`);
      process.exit(1);
    }
    if (cmd === "on") console.log("Sign in once (grades demo or dashboard), then: pnpm attack 3");
  } else {
    console.error("usage: pnpm auth-audit status|on|off");
    process.exit(2);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
