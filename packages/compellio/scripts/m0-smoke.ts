/**
 * M0 "done when": create a TAR through the Registry API, push a 2nd version, then read both checksums
 * straight from the chain with viem and check they equal our own SHA-256(JCS(payload)).
 *
 *   pnpm infra:up && pnpm m0:smoke
 *
 * Env (all optional): REGISTRY_MODE, REGISTRY_URL, GATEWAY_*, CHAIN_RPC_URL. Exit code 0 only if every check passes.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { jcsSha256 } from "@vula/core";
import {
  createRegistryClient,
  createTarReader,
  explorerAddressUrl,
  explorerTxUrl,
  registryConfigFromEnv,
  waitForTarId,
} from "../src/index";

if (existsSync(".env")) process.loadEnvFile(".env");

process.on("unhandledRejection", (err) => {
  const e = err as Error & { status?: number; body?: string };
  console.error(`\n❌ ${e.message}${e.body ? `\n${e.body.split("\n").slice(0, 3).join("\n")}` : ""}`);
  console.log("\nM0 smoke test FAILED\n");
  process.exitCode = 1;
});

const rpcUrl = process.env.CHAIN_RPC_URL || "http://localhost:8545";
const cfg = registryConfigFromEnv();
const registry = createRegistryClient(cfg);

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const run = randomUUID();
const v1 = {
  "@context": "urn:tar:vula:smoke:v1",
  "@type": "VulaSmokeTest",
  run,
  step: 1,
  issuedAt: new Date().toISOString(),
  note: "Vula M0 smoke test: version 1",
};
const expected1 = `0x${jcsSha256(v1)}` as Hex;

console.log(`\nVula M0 smoke test  (registry: ${cfg.mode} ${cfg.baseUrl ?? ""}, chain RPC: ${rpcUrl})\n`);

console.log("1) POST /api/v1/TAR  (create TAR)");
const t0 = Date.now();
const rec1 = await registry.create(v1);
const tarId = rec1.id ?? (await waitForTarId(registry, rec1.receipt)).id;
console.log(`     TAR id   ${tarId}`);
console.log(`     receipt  ${rec1.receipt}   registry version ${rec1.version}   (${Date.now() - t0} ms)`);
check("registry checksum = our SHA-256(JCS(v1))", rec1.checksum === expected1, rec1.checksum);

const v2 = { ...v1, step: 2, issuedAt: new Date().toISOString(), prev: expected1, note: "Vula M0 smoke test: version 2" };
const expected2 = `0x${jcsSha256(v2)}` as Hex;

console.log("\n2) PUT /api/v1/TAR/{id}  (new version)");
const t1 = Date.now();
const rec2 = await registry.update(tarId, v2);
console.log(`     receipt  ${rec2.receipt}   registry version ${rec2.version}   (${Date.now() - t1} ms)`);
check("registry checksum = our SHA-256(JCS(v2))", rec2.checksum === expected2, rec2.checksum);

console.log("\n3) Read the chain directly (viem), trusting nothing else");
const tar = createTarReader({ rpcUrl, tarId });
await tar.assertChain();
const log1 = await tar.waitForChecksum(expected1);
const log2 = await tar.waitForChecksum(expected2);
const total = await tar.totalVersions();
const onchain = await tar.readAll();
check("totalVersions() = 2", total === 2, `got ${total}`);
check("getChecksum(0) = SHA-256(JCS(v1))", onchain[0]?.checksum === expected1, onchain[0]?.checksum);
check("getChecksum(1) = SHA-256(JCS(v2))", onchain[1]?.checksum === expected2, onchain[1]?.checksum);
check("version of v1 checksum is 0 (0-based)", log1.version === 0);
check("version of v2 checksum is 1", log2.version === 1);
check("registry version - 1 = on-chain version", rec2.version - 1 === log2.version, `registry ${rec2.version}`);
console.log(`     contract ${tar.address}  owner ${await tar.owner()}`);
console.log(`     dataUri(0) ${await tar.dataUri(0)}   dataUri(1) ${await tar.dataUri(1)}`);
for (const l of [log1, log2]) {
  console.log(`     v${l.version}  tx ${l.txHash}  block ${l.blockNumber}  ${explorerTxUrl(tar.chainId, l.txHash) ?? "(local chain, no explorer)"}`);
}
const addrUrl = explorerAddressUrl(tar.chainId, tar.address);
if (addrUrl) console.log(`     explorer ${addrUrl}`);

console.log("\n4) Read the payload back from the Registry API and re-hash it (registry treated as untrusted)");
const back = await registry.getVersion(tarId, rec2.version);
check("GET /version/{id}:{v} payload re-hashes to on-chain checksum", back !== null && `0x${jcsSha256(back.data)}` === onchain[1]?.checksum);

console.log(failures.length === 0 ? "\nM0 smoke test PASSED\n" : `\nM0 smoke test FAILED: ${failures.join("; ")}\n`);
// exitCode instead of process.exit(): avoids a libuv assertion on Windows when sockets are still closing.
process.exitCode = failures.length === 0 ? 0 : 1;
