import { EMPTY_ROOT, MerkleTree, toHex } from "@vula/merkle";
import {
  ASSET_SCHEMA_ROOT,
  appAuditEvent,
  batchBytes,
  checkpointProfile,
  jcsSha256,
  batchSha256,
  checkpointChecksum,
  eventLeafHash,
  generateSigningKey,
  heartbeatEvent,
  signCheckpoint,
  signerFromPkcs8,
  type AppAuditRow,
  type CheckpointPayload,
  type EventBatch,
  type VulaEvent,
} from "@vula/core";
import { verifyLog } from "../src/index";
import type { BatchSource, ChainSource, LeafSource, PayloadSource, ProfileSource, StoredLeaf } from "../src/types";

/** Shared test world for the verifier tests (in-memory chain, payload store, leaves, batches). */
// ============================================================ test world
export const ROOT_TAR = "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3";
export const PROFILE_TAR = "urn:tar:eip155.31337:e7f1725e7734ce288f8367e1bb143e90bb3f0512";
export const LOG_TAR = "urn:tar:eip155.31337:9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";

/** A chain holding the root asset schema + VulaCheckpoint profile TARs (checksums), and an untrusted payload store. */
export function profileWorld(over: { profilePayload?: unknown; profileChecksum?: string; rootChecksum?: string; profileVersions?: number } = {}) {
  const profile = checkpointProfile(ROOT_TAR);
  const checksums: Record<string, string[]> = {
    [ROOT_TAR]: [over.rootChecksum ?? `0x${jcsSha256(ASSET_SCHEMA_ROOT)}`],
    [PROFILE_TAR]: Array.from({ length: over.profileVersions ?? 1 }, () => over.profileChecksum ?? `0x${jcsSha256(profile)}`),
  };
  const src: ProfileSource = {
    name: "mem profile",
    chain: (tarId) => ({
      totalVersions: async () => checksums[tarId]?.length ?? 0,
      getChecksum: async (v) => {
        const c = checksums[tarId]?.[v];
        if (!c) throw new Error("no contract");
        return c;
      },
    }),
    getPayload: async (tarId, v) => (tarId === PROFILE_TAR && v === 0 ? (over.profilePayload ?? profile) : null),
  };
  return src;
}

export const STUDENT = "aaaaaaaa-0000-4000-8000-000000000001";
export const COURSE = "cccccccc-0000-4000-8000-000000000001";
export const GRADE = "99999999-0000-4000-8000-000000000001";

export function gradeRow(id: number, op: "INSERT" | "UPDATE", oldGrade: number | null, newGrade: number): AppAuditRow {
  const row = (g: number) => ({ id: GRADE, student_id: STUDENT, course_id: COURSE, grade: g, updated_by: null, updated_at: "2026-11-19T10:00:00+00:00" });
  return {
    id, occurred_at: new Date(Date.UTC(2026, 10, 19, 10, id)), table_name: "app.grades", op, row_pk: GRADE,
    old_row: oldGrade === null ? null : row(oldGrade), new_row: row(newGrade), actor: null, db_user: "uibm_app", txid: 1000 + id,
  };
}

/** Builds a log of `n` checkpoints over a mix of audit events and heartbeats, like the log server does. */
export function buildWorld(opts: { heartbeatEveryMin?: number; gapAfter?: number } = {}) {
  const key = generateSigningKey();
  const signer = signerFromPkcs8(key.privateKey, "test-key");
  const audit: AppAuditRow[] = [gradeRow(1, "INSERT", null, 6), gradeRow(2, "UPDATE", 6, 7), gradeRow(3, "UPDATE", 7, 6)];
  const events: VulaEvent[] = [];
  let hb = 0;
  const t0 = Date.UTC(2026, 10, 19, 10, 0);
  for (let m = 0; m < 12; m++) {
    if (m < audit.length) events.push(appAuditEvent(audit[m]!, m + 1, new Date(t0 + m * 60_000)));
    if (opts.gapAfter !== undefined && m > opts.gapAfter && m < opts.gapAfter + 5) continue; // collector stopped
    events.push(heartbeatEvent("c1", ++hb, {}, new Date(t0 + m * 60_000 + 1000)));
  }
  const tree = new MerkleTree(events.map(eventLeafHash));
  const sizes = [4, 9, events.length];
  const checkpoints: CheckpointPayload[] = [];
  const batches = new Map<string, Uint8Array>();
  let prevSize = 0;
  sizes.forEach((size, seq) => {
    const batch: EventBatch = { "@type": "VulaEventBatch", logId: "t", fromIndex: prevSize, toIndex: size - 1, events: events.slice(prevSize, size) };
    const uri = `mem://batch/${seq}`;
    batches.set(uri, batchBytes(batch));
    checkpoints.push(
      signCheckpoint(
        {
          "@context": PROFILE_TAR, "@type": "VulaCheckpoint", logId: "t", seq,
          treeSize: size, rootHash: toHex(tree.root(size)),
          prevTreeSize: prevSize, prevRootHash: prevSize ? toHex(tree.root(prevSize)) : toHex(EMPTY_ROOT),
          consistencyProof: prevSize ? tree.consistencyProof(prevSize, size).map(toHex) : [],
          batch: { uri, sha256: batchSha256(batch), fromIndex: prevSize, toIndex: size - 1 },
          issuedAt: new Date(t0 + seq * 300_000).toISOString(),
        },
        signer,
      ),
    );
    prevSize = size;
  });
  const chainChecksums = checkpoints.map((c) => `0x${checkpointChecksum(c)}`);
  const leaves: StoredLeaf[] = events.map((e, index) => ({ index, leafHash: eventLeafHash(e), event: structuredClone(e) }));
  const payloadStore = checkpoints.map((c) => structuredClone(c) as unknown);
  return { signer, key, events, tree, checkpoints, chainChecksums, leaves, payloadStore, batches, audit };
}

export type World = ReturnType<typeof buildWorld>;

export function sources(w: World) {
  const chain: ChainSource = {
    tarId: LOG_TAR,
    chainId: 31337,
    totalVersions: async () => w.chainChecksums.length,
    getChecksum: async (v) => w.chainChecksums[v]!,
  };
  const payloads: PayloadSource = { name: "mem", getPayload: async (v) => w.payloadStore[v] ?? null };
  const leaves: LeafSource = { name: "mem leaves", getLeaves: async () => w.leaves.map((l) => ({ ...l })) };
  const batches: BatchSource = { getBatch: async (uri) => w.batches.get(uri) ?? null };
  return { chain, payloads, leaves, batches };
}

export const run = (w: World, extra: Partial<Parameters<typeof verifyLog>[0]> = {}) =>
  verifyLog({ ...sources(w), profile: profileWorld(), now: new Date(Date.UTC(2026, 10, 19, 10, 12)), ...extra });

export const codes = (r: { findings: { code: string; severity: string }[] }) =>
  r.findings.filter((f) => f.severity !== "info").map((f) => f.code);
