import { EMPTY_ROOT, MerkleTree, equalHash, fromHex, hashLeaf, toHex, type Hash } from "@vula/merkle";
import {
  batchSha256,
  diffJson,
  eventLeafHash,
  jcs,
  jcsSha256,
  parseCheckpoint,
  parseEvent,
  sha256Hex,
  verifyCheckpointSignature,
  type CheckpointPayload,
  type EventBatch,
  type VulaEvent,
} from "@vula/core";
import { verifyConsistency } from "@vula/merkle";
import type {
  BatchSource,
  ChainSource,
  CheckpointResult,
  Finding,
  LeafSource,
  PayloadSource,
  ProfileReport,
  ProfileSource,
  VerifyLogReport,
} from "./types";
import { verifyProfile } from "./verify-profile";

export interface VerifyLogOptions {
  chain: ChainSource;
  payloads: PayloadSource;
  leaves: LeafSource;
  /** Optional: authenticated raw batches, used to pinpoint WHICH leaves were altered or removed. */
  batches?: BatchSource;
  /** Pin the checkpoint signing key (base64). Default: trust-on-first-use of TAR version 0's key. */
  trustedPublicKey?: string;
  /** Checks the TAR profile the checkpoints' `@context` points to. Without it only its form is checked. */
  profile?: ProfileSource;
  /** Heartbeat gap that counts as silence (default 150 s). */
  heartbeatGapMs?: number;
  now?: Date;
}

const LAYER = "log-vs-chain" as const;

/**
 * `vula verify-log` (CLAUDE.md §7.5). Walks every TAR version straight from the chain, re-hashes each payload,
 * checks signature, seq, prev-root linkage and the RFC 6962 consistency proof between consecutive checkpoints,
 * then rebuilds the Merkle tree from the stored leaves and compares it with every anchored root.
 */
export async function verifyLog(opts: VerifyLogOptions): Promise<VerifyLogReport> {
  const gapMs = opts.heartbeatGapMs ?? 150_000;
  // ------------------------------------------------ A. chain -> checkpoint payloads
  const { total, results, authentic, findings, pinnedKey, profile } = await verifyCheckpoints(opts);

  // ------------------------------------------------ B. stored leaves -> anchored roots
  const stored = (await opts.leaves.getLeaves()).sort((a, b) => a.index - b.index);
  const hashes: Hash[] = [];
  const byIndex = new Map<number, unknown>();
  let expected = 0;
  for (const leaf of stored) {
    byIndex.set(leaf.index, leaf.event);
    if (leaf.index !== expected) {
      findings.push({
        code: "leaf_gap", severity: "critical", layer: LAYER, index: expected,
        message: `Leaves ${expected}..${leaf.index - 1} are missing from ${opts.leaves.name}`,
        details: { from: expected, to: leaf.index - 1 },
      });
    }
    expected = leaf.index + 1;
    let h: Hash;
    try {
      h = eventLeafHash(parseEvent(leaf.event));
    } catch (e) {
      h = hashLeaf(new TextEncoder().encode(jcs(leaf.event)));
      findings.push({ code: "leaf_invalid", severity: "critical", layer: LAYER, index: leaf.index,
        message: `Leaf ${leaf.index} is not a valid event: ${(e as Error).message}` });
    }
    if (!equalHash(h, leaf.leafHash)) {
      findings.push({ code: "leaf_hash_mismatch", severity: "critical", layer: LAYER, index: leaf.index,
        message: `Leaf ${leaf.index}: stored leaf_hash does not match its event content (event edited)` });
    }
    hashes.push(h);
  }
  const tree = new MerkleTree(hashes);
  const broken: { version: number; payload: CheckpointPayload }[] = [];
  for (const a of authentic) {
    const p = a.payload;
    if (tree.size < p.treeSize) {
      a.result.checks.push({ name: "stored leaves reproduce anchored root", ok: false, detail: `${tree.size} < ${p.treeSize} leaves` });
      a.result.ok = false;
      findings.push({
        code: "log_truncated", severity: "critical", layer: LAYER, version: a.version,
        message: `Log truncated: ${opts.leaves.name} has ${tree.size} leaves but TAR version ${a.version} anchored ${p.treeSize}`,
        details: { stored: tree.size, anchored: p.treeSize, missing: p.treeSize - tree.size },
      });
      broken.push(a);
    } else {
      const ok = toHex(tree.root(p.treeSize)) === p.rootHash;
      a.result.checks.push({ name: "stored leaves reproduce anchored root", ok, detail: `leaves 0..${p.treeSize - 1}` });
      if (!ok) {
        a.result.ok = false;
        findings.push({
          code: "root_mismatch", severity: "critical", layer: LAYER, version: a.version,
          message: `Stored leaves no longer reproduce the root anchored in TAR version ${a.version} (leaves 0..${p.treeSize - 1}): the log was tampered with`,
          details: { anchored: p.rootHash, recomputed: toHex(tree.root(p.treeSize)) },
        });
        broken.push(a);
      }
    }
  }

  // ------------------------------------------------ C. pinpoint with the anchored batches
  const referenceEvents: (VulaEvent | undefined)[] = [];
  if (broken.length > 0 && opts.batches) {
    for (const a of authentic) {
      const bytes = await opts.batches.getBatch(a.payload.batch.uri);
      if (!bytes) {
        findings.push({ code: "batch_missing", severity: "warning", layer: LAYER, version: a.version,
          message: `Batch for TAR version ${a.version} is not available; cannot pinpoint leaves ${a.payload.batch.fromIndex}..${a.payload.batch.toIndex}` });
        continue;
      }
      if (sha256Hex(bytes) !== a.payload.batch.sha256) {
        findings.push({ code: "batch_tampered", severity: "critical", layer: LAYER, version: a.version,
          message: `Batch for TAR version ${a.version} does not match the SHA-256 in the anchored checkpoint` });
        continue;
      }
      const batch = JSON.parse(new TextDecoder().decode(bytes)) as EventBatch;
      if (batchSha256(batch) !== a.payload.batch.sha256) continue;
      batch.events.forEach((e, i) => (referenceEvents[batch.fromIndex + i] = e));
    }
    const maxAnchored = authentic.at(-1)?.payload.treeSize ?? 0;
    for (let i = 0; i < maxAnchored; i++) {
      const ref = referenceEvents[i];
      if (!ref) continue;
      const cur = byIndex.get(i);
      if (cur === undefined) {
        findings.push({ code: "leaf_deleted", severity: "critical", layer: LAYER, index: i,
          message: `Leaf ${i} was DELETED from the log: ${describe(ref)}`, details: { anchored: ref } });
      } else if (jcs(cur) !== jcs(ref)) {
        findings.push({ code: "leaf_altered", severity: "critical", layer: LAYER, index: i,
          message: `Leaf ${i} was ALTERED: ${describe(ref)}`, details: { changes: diffJson(ref, cur) } });
      }
    }
  }

  // ------------------------------------------------ D. heartbeats (silence) + exposure window
  const events = stored.map((l) => l.event as VulaEvent);
  const beats = events.filter((e) => e?.source === "vula.heartbeat").map((e) => Date.parse(e.occurredAt)).sort((a, b) => a - b);
  for (let i = 1; i < beats.length; i++) {
    if (beats[i]! - beats[i - 1]! > gapMs) {
      findings.push({
        code: "heartbeat_gap", severity: "warning", layer: LAYER,
        message: `No collector heartbeat for ${Math.round((beats[i]! - beats[i - 1]!) / 1000)} s (${new Date(beats[i - 1]!).toISOString()} -> ${new Date(beats[i]!).toISOString()})`,
        details: { from: new Date(beats[i - 1]!).toISOString(), to: new Date(beats[i]!).toISOString() },
      });
    }
  }
  const now = (opts.now ?? new Date()).getTime();
  if (beats.length > 0 && now - beats.at(-1)! > gapMs) {
    findings.push({
      code: "collector_silent", severity: "warning", layer: LAYER,
      message: `Collector silent: last heartbeat ${Math.round((now - beats.at(-1)!) / 1000)} s ago`,
      details: { lastHeartbeat: new Date(beats.at(-1)!).toISOString() },
    });
  }
  const anchoredTreeSize = authentic.at(-1)?.payload.treeSize ?? 0;
  const unanchored = Math.max(0, stored.length - anchoredTreeSize);
  if (unanchored > 0) {
    findings.push({ code: "unanchored_tail", severity: "info", layer: LAYER,
      message: `${unanchored} leaves captured but not anchored yet (exposure window until the next checkpoint)` });
  }

  const firstBrokenResult = results.find((r) => !r.ok);
  const firstFinding = findings.find((f) => f.severity === "critical" && f.version === firstBrokenResult?.version);
  return {
    ok: !findings.some((f) => f.severity === "critical"),
    tarId: opts.chain.tarId,
    chainId: opts.chain.chainId,
    totalVersions: total,
    signerPublicKey: pinnedKey,
    profile,
    anchoredTreeSize,
    storedLeaves: stored.length,
    unanchoredLeaves: unanchored,
    checkpoints: results,
    firstBroken: firstBrokenResult
      ? { version: firstBrokenResult.version, reason: firstFinding?.message ?? firstBrokenResult.checks.find((c) => !c.ok)?.name ?? "failed" }
      : null,
    findings,
  };
}

export interface AuthenticCheckpoint {
  version: number;
  payload: CheckpointPayload;
  result: CheckpointResult;
}

/**
 * Part A of verify-log, shared with verify-event: walks every TAR version from the chain and returns the prefix
 * of checkpoints that are authentic (checksum, signature, key, seq, linkage, consistency). Stops at the first
 * broken version: nothing after it can be trusted to chain from it.
 */
export async function verifyCheckpoints(opts: Pick<VerifyLogOptions, "chain" | "payloads" | "trustedPublicKey" | "profile">): Promise<{
  total: number;
  results: CheckpointResult[];
  authentic: AuthenticCheckpoint[];
  findings: Finding[];
  pinnedKey: string | null;
  profile: ProfileReport | null;
}> {
  const findings: Finding[] = [];
  const results: CheckpointResult[] = [];
  const authentic: AuthenticCheckpoint[] = [];
  const total = await opts.chain.totalVersions();
  let prev: CheckpointPayload | null = null;
  let pinnedKey = opts.trustedPublicKey ?? null;
  let profile: ProfileReport | null = null;

  for (let v = 0; v < total; v++) {
    const result: CheckpointResult = { version: v, ok: true, checks: [] };
    results.push(result);
    const check = (name: string, ok: boolean, detail?: string) => {
      result.checks.push({ name, ok, detail });
      if (!ok) result.ok = false;
      return ok;
    };
    const fail = (code: string, message: string, details?: Record<string, unknown>) =>
      findings.push({ code, severity: "critical", layer: LAYER, version: v, message, details });

    const onchain = (await opts.chain.getChecksum(v)).toLowerCase().replace(/^0x/, "");
    const raw = await opts.payloads.getPayload(v);
    if (!check("payload available", raw !== null && raw !== undefined, opts.payloads.name)) {
      fail("payload_missing", `No payload found for TAR version ${v} (source: ${opts.payloads.name})`);
      break;
    }
    const got = jcsSha256(raw);
    if (!check("SHA-256(JCS(payload)) = on-chain checksum", got === onchain, `chain 0x${onchain.slice(0, 16)}...`)) {
      fail(
        "payload_mismatch",
        `Checkpoint store tampered: payload for TAR version ${v} from ${opts.payloads.name} does not match the checksum anchored on-chain`,
        { onchain: `0x${onchain}`, computed: `0x${got}` },
      );
      break;
    }
    let p: CheckpointPayload;
    try {
      p = parseCheckpoint(raw);
    } catch (e) {
      check("payload is a valid VulaCheckpoint", false, (e as Error).message);
      fail("payload_invalid", `TAR version ${v} is not a valid Vula checkpoint: ${(e as Error).message}`);
      break;
    }
    Object.assign(result, { seq: p.seq, treeSize: p.treeSize, rootHash: p.rootHash, issuedAt: p.issuedAt });

    // Compellio TAR model: @context = the TAR profile describing the record type. Checked on-chain once (v0),
    // then every later checkpoint must keep pointing at the same profile.
    if (!prev) {
      if (opts.profile) {
        const pr = await verifyProfile(p["@context"], opts.chain.chainId, opts.profile);
        profile = pr.report;
        findings.push(...pr.findings);
        const bad = pr.checks.find((c) => !c.ok);
        check("@context = registered VulaCheckpoint TAR profile", !bad, bad ? `${bad.name}: ${bad.detail ?? "failed"}` : p["@context"]);
      }
    } else if (!check("@context = same TAR profile as version 0", p["@context"] === authentic[0]?.payload["@context"], p["@context"])) {
      fail("profile_changed", `TAR version ${v} points to another TAR profile (${p["@context"]})`);
    }

    pinnedKey ??= p.signer.publicKey;
    const sigOk = check("Ed25519 signature valid", verifyCheckpointSignature(p));
    const keyOk = check("signed by the pinned log key", p.signer.publicKey === pinnedKey, p.signer.keyId);
    const seqOk = check("seq = TAR version", p.seq === v, `seq ${p.seq}`);
    const logOk = check("same logId as version 0", !prev || p.logId === authentic[0]?.payload.logId, p.logId);
    const linkOk = prev
      ? check("prev = previous anchored checkpoint", p.prevTreeSize === prev.treeSize && p.prevRootHash === prev.rootHash,
          `prev ${p.prevTreeSize} / ${p.prevRootHash.slice(0, 12)}...`)
      : check("first checkpoint starts from the empty tree",
          p.prevTreeSize === 0 && p.prevRootHash === toHex(EMPTY_ROOT) && p.consistencyProof.length === 0);
    const growOk = check("tree grew", p.treeSize > p.prevTreeSize, `${p.prevTreeSize} -> ${p.treeSize}`);
    const consOk = prev
      ? check(
          "RFC 6962 consistency proof (append-only)",
          verifyConsistency(prev.treeSize, p.treeSize, fromHex(prev.rootHash), fromHex(p.rootHash), p.consistencyProof.map(fromHex)),
          `${prev.treeSize} -> ${p.treeSize}`,
        )
      : true;
    const batchOk = check("batch covers exactly the new leaves",
      p.batch.fromIndex === p.prevTreeSize && p.batch.toIndex === p.treeSize - 1);

    if (!sigOk) fail("bad_signature", `TAR version ${v}: checkpoint signature is invalid`);
    if (!keyOk) fail("unknown_signer", `TAR version ${v} is signed by an unexpected key ${p.signer.keyId}`, { publicKey: p.signer.publicKey });
    if (!seqOk) fail("seq_mismatch", `TAR version ${v} carries seq ${p.seq}`);
    if (!logOk) fail("log_id_mismatch", `TAR version ${v} belongs to log ${p.logId}`);
    if (!linkOk) fail("broken_link", `TAR version ${v} does not chain from the previous anchored checkpoint`);
    if (!growOk) fail("no_growth", `TAR version ${v}: tree did not grow (${p.prevTreeSize} -> ${p.treeSize})`);
    if (!consOk) {
      fail("inconsistent", `TAR version ${v} is NOT an append-only extension of version ${v - 1}: history was rewritten or entries dropped`, {
        from: prev!.treeSize, to: p.treeSize,
      });
    }
    if (!batchOk) fail("bad_batch_range", `TAR version ${v}: batch range ${p.batch.fromIndex}..${p.batch.toIndex} is wrong`);
    if (!result.ok) break; // later versions cannot be trusted to chain from a broken one
    authentic.push({ version: v, payload: p, result });
    prev = p;
  }
  return { total, results, authentic, findings, pinnedKey, profile };
}

export function describe(e: VulaEvent): string {
  const d = e.data as Record<string, unknown> | null;
  const grade = (x: unknown) => (x && typeof x === "object" && "grade" in x ? (x as { grade: unknown }).grade : undefined);
  const g = d ? `${grade(d.old) ?? ""}${grade(d.old) !== undefined && grade(d.new) !== undefined ? " -> " : ""}${grade(d.new) ?? ""}` : "";
  return `${e.action} ${e.target ?? ""}${g ? ` (grade ${g})` : ""} at ${e.occurredAt} by ${e.actor ?? "?"}`;
}
