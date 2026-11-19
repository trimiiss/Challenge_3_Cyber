import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";
import postgres from "postgres";

let teeing = false;
/** If VULA_LOG_FILE is set (by scripts/stack.ts), also append console output there (works for detached services). */
function teeConsoleToFile(): void {
  const file = process.env.VULA_LOG_FILE;
  if (!file || teeing) return;
  teeing = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        appendFileSync(file, `${new Date().toISOString()} ${format(...args)}\n`);
      } catch {
        /* never let logging break the service */
      }
    };
  }
}

/**
 * Database roles (supabase/migrations/*_vula_roles_rls.sql):
 *   vula_log      log server + collector
 *   vula_auditor  verifier (read-only + may append alerts)
 *   uibm_app      UIBM Grades app backend
 *   uibm_admin    the insider DBA of the demo story (attacks only)
 */
export type DbRole = "vula_log" | "vula_auditor" | "uibm_app" | "uibm_admin";

const PASSWORD_ENV: Record<DbRole, string> = {
  vula_log: "VULA_LOG_DB_PASSWORD",
  vula_auditor: "VULA_AUDITOR_DB_PASSWORD",
  uibm_app: "UIBM_APP_DB_PASSWORD",
  uibm_admin: "UIBM_ADMIN_DB_PASSWORD",
};

/** Loads the repo-root .env once (walks up from cwd), without overriding variables already set. */
export function loadEnv(): void {
  teeConsoleToFile();
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = join(dir, ".env");
    if (existsSync(f)) {
      process.loadEnvFile(f);
      return;
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

/**
 * Connection URL through Supabase's IPv4 session pooler (Supavisor). The user is `<role>.<project ref>`.
 * DATABASE_URL_<ROLE> overrides it (e.g. a local Postgres).
 */
export function databaseUrl(role: DbRole): string {
  const override = process.env[`DATABASE_URL_${role.toUpperCase()}`];
  if (override) return override;
  const ref = requireEnv("SUPABASE_PROJECT_REF");
  const host = requireEnv("SUPABASE_POOLER_HOST");
  const pw = encodeURIComponent(requireEnv(PASSWORD_ENV[role]));
  return `postgres://${role}.${ref}:${pw}@${host}:5432/postgres`;
}

export type Sql = postgres.Sql;

export function connect(role: DbRole, opts: { max?: number } = {}): Sql {
  return postgres(databaseUrl(role), {
    max: opts.max ?? 3, // free tier: 60 connections for the whole project
    ssl: databaseUrl(role).includes("pooler.supabase.com") ? "require" : undefined,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    types: {
      // keep bigint columns as JS numbers (our indexes stay far below 2^53)
      bigint: { to: 20, from: [20], serialize: (x: number) => x.toString(), parse: (x: string) => Number(x) },
    },
  });
}

export function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

export function bytes(hexStr: string): Buffer {
  return Buffer.from(hexStr.replace(/^0x/, ""), "hex");
}
