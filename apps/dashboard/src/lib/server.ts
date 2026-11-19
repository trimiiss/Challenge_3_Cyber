// Server-side only (imported from route handlers).
import { createClient } from "@supabase/supabase-js";
import { auditorDb } from "@vula/verifier/run";

/** Every API route requires a Supabase Auth session of a user with the auditor (or admin) role. */
export async function requireAuditor(req: Request): Promise<{ id: string; email: string } | Response> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "sign in required" }, { status: 401 });
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return Response.json({ error: "invalid session" }, { status: 401 });
  const rows = await auditorDb()<{ role: string }[]>`select role from app.roles where user_id = ${data.user.id}`;
  if (!["auditor", "admin"].includes(rows[0]?.role ?? "")) return Response.json({ error: "auditor role required" }, { status: 403 });
  return { id: data.user.id, email: data.user.email ?? "" };
}

export const isDemoMode = () => (process.env.VULA_DEMO_MODE ?? "1") === "1";
