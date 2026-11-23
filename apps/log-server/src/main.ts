import { createRegistryClient, registryConfigFromEnv } from "@vula/compellio";
import { signerFromPkcs8 } from "@vula/core";
import { connect } from "@vula/db";
import { toHex } from "@vula/merkle";
import { config } from "./config";
import { Store } from "./store";
import { LogService } from "./log";
import { Anchorer } from "./anchor";
import { BatchStore } from "./batches";
import { buildServer } from "./server";
import { CtiPublisher } from "./cti";

const store = new Store(connect("vula_log", { max: 4 }));
const log = new LogService(store);
const signer = signerFromPkcs8(config.signingKey, config.signingKeyId);
const registry = createRegistryClient(registryConfigFromEnv());
const batches = new BatchStore(config.supabaseUrl, config.supabaseKey, config.serviceEmail, config.servicePassword);
const anchorer = new Anchorer({
  store, log, registry, batches, signer,
  logId: config.logId, rpcUrl: config.rpcUrl, intervalMs: config.checkpointIntervalMs,
});

// ------------------------------------------------------------------ startup
const issues = await log.init();
await anchorer.init();
console.log(`[vula] log ${config.logId}: ${log.size} leaves, ${anchorer.checkpoints.length} checkpoints, TAR ${anchorer.tar?.tarId ?? "(none yet)"}`);
console.log(`[vula] registry ${registry.mode}, chain ${config.rpcUrl}, signer ${signer.keyId} ${signer.publicKey}`);

for (const i of issues) {
  console.error(`[integrity] ${i.message}`);
  await store.alert(i.kind, "critical", `Log server startup: ${i.message}`, i.details ?? {});
}
// The stored log must still reproduce the last anchored root, or new checkpoints would chain from forged data.
const last = anchorer.lastAnchored;
if (last) {
  const ok = log.size >= last.tree_size && toHex(log.tree.root(last.tree_size)) === toHex(last.root_hash);
  if (!ok) {
    anchorer.halted = `stored leaves no longer reproduce anchored checkpoint seq ${last.seq}`;
    console.error(`[integrity] ${anchorer.halted}. Checkpointing halted.`);
    await store.alert("log_tampered", "critical", "Stored log does not match the last anchored checkpoint", {
      seq: last.seq, anchoredTreeSize: last.tree_size, storedLeaves: log.size,
    });
  }
}

// ---------------------------------------------------------------- watchdog
const startedAt = Date.now();
let gapOpen = false;
async function watchdog(): Promise<void> {
  const since = log.lastHeartbeatAt ?? startedAt;
  const silentMs = Date.now() - since;
  if (!gapOpen && silentMs > config.heartbeatGapMs) {
    gapOpen = true;
    console.error(`[watchdog] no heartbeat for ${Math.round(silentMs / 1000)} s`);
    await store.alert("heartbeat_gap", "critical", `No collector heartbeat for ${Math.round(silentMs / 1000)} s`, {
      lastHeartbeatAt: log.lastHeartbeatAt ? new Date(log.lastHeartbeatAt).toISOString() : null,
      thresholdS: config.heartbeatGapMs / 1000,
    });
  } else if (gapOpen && silentMs <= config.heartbeatGapMs) {
    gapOpen = false;
    console.log("[watchdog] heartbeats resumed");
    await store.alert("heartbeat_resumed", "info", "Collector heartbeats resumed", {});
  }
}

// ------------------------------------------------------------------ server
const app = buildServer({
  log, anchorer, ingestToken: config.ingestToken, logId: config.logId,
  loadCheckpoints: () => store.loadCheckpoints(),
  watchdog: () => ({ gapOpen, lastHeartbeatAt: log.lastHeartbeatAt ? new Date(log.lastHeartbeatAt).toISOString() : null }),
});
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[vula] log server on :${config.port}, checkpoint every ${config.checkpointIntervalMs / 1000} s`);

// The anchorer gates itself: new checkpoints at most once per interval, failed anchors on their own backoff.
const timers = [
  setInterval(() => void anchorer.tick().catch((e) => console.error("[anchor]", e)), 5_000),
  setInterval(() => void watchdog().catch((e) => console.error("[watchdog]", e)), 5_000),
];
if (config.bcbctiUrl) {
  const cti = new CtiPublisher(store.sql, { url: config.bcbctiUrl, logId: config.logId, logTarId: () => anchorer.tar?.tarId ?? null });
  timers.push(setInterval(() => void cti.tick().catch((e) => console.error("[cti]", (e as Error).message)), 3_000));
  console.log(`[vula] sharing alerts as STIX incidents with BCBCTI at ${config.bcbctiUrl}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    timers.forEach(clearInterval);
    await app.close();
    await store.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
