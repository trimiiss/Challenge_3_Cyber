import { ASSET_SCHEMA_ROOT, CHECKPOINT_PROFILE_ID, jcsSha256, matchCheckpointProfile, tarIdChainId } from "@vula/core";
import type { Check, Finding, ProfileReport, ProfileSource } from "./types";

/**
 * Checks the TAR a checkpoint's `@context` points to (Compellio TAR Profiles): it must be on the log's chain, its
 * version 0 must be exactly the VulaCheckpoint profile document (re-hashed against the chain), and that profile's
 * own `@context[0]` must be a TAR holding DCAP.Web's root asset schema. Both documents are fixed in @vula/core, so
 * the only untrusted input is the copy of the profile payload (which carries the root TAR id).
 */
export async function verifyProfile(
  profileTarId: string,
  logChainId: number,
  src: ProfileSource,
): Promise<{ report: ProfileReport; checks: Check[]; findings: Finding[] }> {
  const checks: Check[] = [];
  const findings: Finding[] = [];
  const report: ProfileReport = { tarId: profileTarId, rootSchemaTarId: null, versions: 0, ok: false, source: src.name };
  const check = (name: string, ok: boolean, detail?: string) => (checks.push({ name, ok, detail }), ok);
  const fail = (message: string, details?: Record<string, unknown>) =>
    findings.push({ code: "profile_invalid", severity: "critical", layer: "log-vs-chain", version: 0, message, details });
  const done = () => ({ report, checks, findings });

  if (!check("profile TAR on the log's chain", tarIdChainId(profileTarId) === logChainId, profileTarId)) {
    fail(`Checkpoint @context ${profileTarId} is not a TAR on chain ${logChainId}`);
    return done();
  }
  const chain = src.chain(profileTarId);
  const versions = await chain.totalVersions().catch(() => 0);
  report.versions = versions;
  if (!check("profile TAR exists on-chain", versions > 0)) {
    fail(`Checkpoint @context ${profileTarId} is not a TAR on chain ${logChainId} (no contract / no versions)`);
    return done();
  }
  const payload = await src.getPayload(profileTarId, 0);
  if (!check("profile payload available", payload !== null && payload !== undefined, src.name)) {
    fail(`No payload found for the TAR profile ${profileTarId} (source: ${src.name})`);
    return done();
  }
  const onchain = (await chain.getChecksum(0)).toLowerCase().replace(/^0x/, "");
  const got = jcsSha256(payload);
  if (!check("profile: SHA-256(JCS(payload)) = on-chain checksum", got === onchain)) {
    fail(`TAR profile payload from ${src.name} does not match the checksum anchored for ${profileTarId}`, {
      onchain: `0x${onchain}`, computed: `0x${got}`,
    });
    return done();
  }
  const m = matchCheckpointProfile(payload);
  if (!m.ok) {
    check(`profile is ${CHECKPOINT_PROFILE_ID}`, false, m.reason);
    fail(`TAR ${profileTarId} is not the Vula checkpoint profile: ${m.reason}`);
    return done();
  }
  check(`profile is ${CHECKPOINT_PROFILE_ID}`, true);
  report.rootSchemaTarId = m.rootSchemaTarId;
  const rootOk =
    tarIdChainId(m.rootSchemaTarId) === logChainId &&
    (await src.chain(m.rootSchemaTarId).getChecksum(0).then(
      (c) => c.toLowerCase().replace(/^0x/, "") === jcsSha256(ASSET_SCHEMA_ROOT),
      () => false,
    ));
  if (!check("profile's @context[0] = root asset schema TAR", rootOk, m.rootSchemaTarId)) {
    fail(`The root asset schema TAR ${m.rootSchemaTarId} of the profile does not hold DCAP's root asset schema`);
    return done();
  }
  if (versions > 1) {
    findings.push({
      code: "profile_updated", severity: "warning", layer: "log-vs-chain", version: 0,
      message: `TAR profile ${profileTarId} has ${versions} versions on-chain; Vula only ever registers version 0`,
    });
  }
  report.ok = true;
  return done();
}
