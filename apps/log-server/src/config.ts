import { loadEnv, requireEnv } from "@vula/db";

loadEnv();

const num = (name: string, def: number) => (process.env[name] ? Number(process.env[name]) : def);

export const config = {
  port: num("LOG_SERVER_PORT", 4000),
  logId: process.env.VULA_LOG_ID || "uibm-grades-prod",
  signingKey: requireEnv("VULA_SIGNING_KEY"),
  signingKeyId: process.env.VULA_SIGNING_KEY_ID || "vula-2026-1",
  ingestToken: requireEnv("VULA_INGEST_TOKEN"),
  /** Checkpoint cadence: 1 min locally, 5 min on testnet (CLAUDE.md §7.3). */
  checkpointIntervalMs: num("CHECKPOINT_INTERVAL_MS", 60_000),
  /** No heartbeat for this long = alert. Default 2.5 × the 60 s heartbeat interval. */
  heartbeatGapMs: num("HEARTBEAT_GAP_MS", 150_000),
  rpcUrl: process.env.CHAIN_RPC_URL || "http://localhost:8545",
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseKey: requireEnv("SUPABASE_PUBLISHABLE_KEY"),
  serviceEmail: requireEnv("LOGSERVER_EMAIL"),
  servicePassword: requireEnv("LOGSERVER_PASSWORD"),
};
