import { describe, expect, it } from "vitest";
import { EMPTY_ROOT, MerkleTree, fromHex, toHex, verifyInclusion } from "@vula/merkle";
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
import { reconcile, verifyEvent, verifyLog, type ReconcileSource } from "../src/index";
import type { BatchSource, ChainSource, LeafSource, PayloadSource, ProfileSource, StoredLeaf } from "../src/types";

// ============================================================ test world
const ROOT_TAR = "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3";
const PROFILE_TAR = "urn:tar:eip155.31337:e7f1725e7734ce288f8367e1bb143e90bb3f0512";
const LOG_TAR = "urn:tar:eip155.31337:9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";

/** A chain holding the root asset schema + VulaCheckpoint profile TARs (checksums), and an untrusted payload store. */
function profileWorld(over: { profilePayload?: unknown; profileChecksum?: string; rootChecksum?: string; profileVersions?: number } = {}) {
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

const STUDENT = "aaaaaaaa-0000-4000-8000-000000000001";
const COURSE = "cccccccc-0000-4000-8000-000000000001";
const GRADE = "99999999-0000-4000-8000-000000000001";

function gradeRow(id: number, op: "INSERT" | "UPDATE", oldGrade: number | null, newGrade: number): AppAuditRow {
  const row = (g: number) => ({ id: GRADE, student_id: STUDENT, course_id: COURSE, grade: g, updated_by: null, updated_at: "2026-11-19T10:00:00+00:00" });
  return {
    id, occurred_at: new Date(Date.UTC(2026, 10, 19, 10, id)), table_name: "app.grades", op, row_pk: GRADE,
    old_row: oldGrade === null ? null : row(oldGrade), new_row: row(newGrade), actor: null, db_user: "uibm_app", txid: 1000 + id,
  };
}

/** Builds a log of `n` checkpoints over a mix of audit events and heartbeats, like the log server does. */
function buildWorld(opts: { heartbeatEveryMin?: number; gapAfter?: number } = {}) {
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

type World = ReturnType<typeof buildWorld>;

function sources(w: World) {
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

const run = (w: World, extra: Partial<Parameters<typeof verifyLog>[0]> = {}) =>
  verifyLog({ ...sources(w), profile: profileWorld(), now: new Date(Date.UTC(2026, 10, 19, 10, 12)), ...extra });

const codes = (r: { findings: { code: string; severity: string }[] }) =>
  r.findings.filter((f) => f.severity !== "info").map((f) => f.code);

// ============================================================ verify-log
describe("verify-log", () => {
  it("clean log: every checkpoint ✅", async () => {
    const r = await run(buildWorld());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.totalVersions).toBe(3);
    expect(r.checkpoints.every((c) => c.ok)).toBe(true);
    expect(r.anchoredTreeSize).toBe(r.storedLeaves);
    expect(r.firstBroken).toBeNull();
    expect(r.profile).toMatchObject({ tarId: PROFILE_TAR, rootSchemaTarId: ROOT_TAR, versions: 1, ok: true });
    expect(r.checkpoints[0]!.checks.find((c) => c.name.startsWith("@context"))?.ok).toBe(true);
  });

  it("attack 4: edited leaf (hash recomputed to look consistent) -> root mismatch at the covering checkpoint, pinpointed", async () => {
    const w = buildWorld();
    // leaf 0 is the grade INSERT (grade 6). Edit it to 10 and fix up both dataSha256 and leaf_hash.
    const e = structuredClone(w.events[0]!) as VulaEvent;
    (e.data as { new: { grade: number } }).new.grade = 10;
    const forged = appAuditEvent({ ...w.audit[0]!, new_row: { ...w.audit[0]!.new_row!, grade: 10 } }, 1, new Date(e.capturedAt));
    w.leaves[0] = { index: 0, leafHash: eventLeafHash(forged), event: forged };
    const r = await run(w);
    expect(r.ok).toBe(false);
    expect(r.firstBroken?.version).toBe(0);
    expect(codes(r)).toContain("root_mismatch");
    const altered = r.findings.find((f) => f.code === "leaf_altered");
    expect(altered?.index).toBe(0);
    expect(altered?.details?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "data.new.grade", before: 6, after: 10 })]),
    );
  });

  it("edited event without fixing leaf_hash is also flagged", async () => {
    const w = buildWorld();
    (w.leaves[5]!.event as VulaEvent).actor = "someone-else";
    const r = await run(w);
    expect(codes(r)).toEqual(expect.arrayContaining(["leaf_hash_mismatch", "root_mismatch", "leaf_altered"]));
    expect(r.firstBroken?.version).toBe(1);
  });

  it("attack 5: truncation (newest leaves deleted) -> tree size < anchored size", async () => {
    const w = buildWorld();
    w.leaves = w.leaves.slice(0, -3);
    const r = await run(w);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("log_truncated");
    expect(r.findings.filter((f) => f.code === "leaf_deleted").map((f) => f.index)).toEqual([
      w.events.length - 3, w.events.length - 2, w.events.length - 1,
    ]);
  });

  it("deleting a middle leaf is caught (gap + root mismatch + pinpointed)", async () => {
    const w = buildWorld();
    w.leaves.splice(2, 1);
    const r = await run(w);
    expect(codes(r)).toEqual(expect.arrayContaining(["leaf_gap", "root_mismatch", "leaf_deleted"]));
    expect(r.findings.find((f) => f.code === "leaf_deleted")?.index).toBe(2);
  });

  it("attack 6: rewritten checkpoint store -> payload does not match the chain (chain wins)", async () => {
    const w = buildWorld();
    (w.payloadStore[1] as CheckpointPayload).treeSize = 8;
    const r = await run(w);
    expect(codes(r)).toContain("payload_mismatch");
    expect(r.firstBroken?.version).toBe(1);
  });

  it("attack 7: stolen key forges a checkpoint that drops old entries -> consistency proof fails", async () => {
    const w = buildWorld();
    // Attacker rebuilds history without leaf 1, signs a new checkpoint with the stolen key and anchors it.
    const forgedEvents = w.events.filter((_, i) => i !== 1);
    const ft = new MerkleTree(forgedEvents.map(eventLeafHash));
    const prev = w.checkpoints[2]!;
    const size = forgedEvents.length + 2;
    const extra = [heartbeatEvent("c1", 900, {}), heartbeatEvent("c1", 901, {})];
    extra.forEach((e) => ft.appendLeafHash(eventLeafHash(e)));
    const batch: EventBatch = { "@type": "VulaEventBatch", logId: "t", fromIndex: prev.treeSize, toIndex: size - 1, events: extra };
    const forged = signCheckpoint(
      {
        "@context": PROFILE_TAR, "@type": "VulaCheckpoint", logId: "t", seq: 3, treeSize: size,
        rootHash: toHex(ft.root()), prevTreeSize: prev.treeSize, prevRootHash: prev.rootHash,
        consistencyProof: ft.consistencyProof(prev.treeSize, size).map(toHex),
        batch: { uri: "mem://batch/3", sha256: batchSha256(batch), fromIndex: prev.treeSize, toIndex: size - 1 },
        issuedAt: new Date().toISOString(),
      },
      w.signer,
    );
    w.payloadStore.push(forged);
    w.chainChecksums.push(`0x${checkpointChecksum(forged)}`);
    const r = await run(w);
    expect(codes(r)).toContain("inconsistent");
    expect(r.firstBroken?.version).toBe(3);
    // earlier, honest history stays verified
    expect(r.checkpoints.slice(0, 3).every((c) => c.ok)).toBe(true);
  });

  it("a checkpoint signed by a different key is rejected", async () => {
    const w = buildWorld();
    const other = signerFromPkcs8(generateSigningKey().privateKey, "test-key");
    const { signature: _s, signer: _k, ...unsigned } = w.checkpoints[1]!;
    const resigned = signCheckpoint(unsigned, other);
    w.payloadStore[1] = resigned;
    w.chainChecksums[1] = `0x${checkpointChecksum(resigned)}`;
    const r = await run(w);
    expect(codes(r)).toContain("unknown_signer");
  });

  it("pinning the expected key rejects a log whose version 0 uses another key", async () => {
    const r = await run(buildWorld(), { trustedPublicKey: generateSigningKey().publicKey });
    expect(codes(r)).toContain("unknown_signer");
  });

  it("attack 8: collector stopped -> heartbeat gap reported", async () => {
    const r = await run(buildWorld({ gapAfter: 5 }), { heartbeatGapMs: 150_000 });
    const gap = r.findings.find((f) => f.code === "heartbeat_gap");
    expect(gap?.severity).toBe("warning");
    expect(gap?.message).toMatch(/No collector heartbeat for 3\d\d s/);
  });

  it("tampered batch is detected (its hash is anchored)", async () => {
    const w = buildWorld();
    w.batches.set("mem://batch/0", new TextEncoder().encode('{"tampered":true}'));
    w.leaves.splice(1, 1); // force pinpointing
    const r = await run(w);
    expect(codes(r)).toContain("batch_tampered");
  });
});

// ============================================================ TAR profile (@context)
describe("verify-log: TAR profile", () => {
  /** Re-signs checkpoint `v` with another @context and re-anchors it (as a key holder could). */
  function withContext(w: World, v: number, context: string) {
    const { signature: _s, signer: _k, ...unsigned } = w.checkpoints[v]!;
    const cp = signCheckpoint({ ...unsigned, "@context": context }, w.signer);
    w.payloadStore[v] = cp;
    w.chainChecksums[v] = `0x${checkpointChecksum(cp)}`;
    return w;
  }

  it("profile payload altered in the untrusted store -> does not match its on-chain checksum", async () => {
    const tampered = { ...checkpointProfile(ROOT_TAR), "schema:description": "anything goes" };
    const r = await run(buildWorld(), { profile: { ...profileWorld(), getPayload: async () => tampered } });
    expect(codes(r)).toContain("profile_invalid");
    expect(r.profile?.ok).toBe(false);
    expect(r.firstBroken?.version).toBe(0);
    expect(r.ok).toBe(false);
  });

  it("@context points to a TAR that is not the Vula checkpoint profile -> rejected", async () => {
    const other = { "@context": "urn:tar:...", "@type": "stixBundle" };
    const r = await run(buildWorld(), { profile: profileWorld({ profilePayload: other, profileChecksum: `0x${jcsSha256(other)}` }) });
    expect(r.findings.find((f) => f.code === "profile_invalid")?.message).toMatch(/not the Vula checkpoint profile/);
  });

  it("profile whose root TAR does not hold DCAP's root asset schema -> rejected", async () => {
    const r = await run(buildWorld(), { profile: profileWorld({ rootChecksum: `0x${"00".repeat(32)}` }) });
    expect(r.findings.find((f) => f.code === "profile_invalid")?.message).toMatch(/root asset schema/);
  });

  it("@context TAR does not exist on-chain -> rejected", async () => {
    const r = await run(withContext(buildWorld(), 0, "urn:tar:eip155.31337:" + "ab".repeat(20)));
    expect(r.findings.find((f) => f.code === "profile_invalid")?.message).toMatch(/no contract/);
  });

  it("@context TAR on another chain -> rejected", async () => {
    const r = await run(withContext(buildWorld(), 0, "urn:tar:eip155.127823:e7f1725e7734ce288f8367e1bb143e90bb3f0512"));
    expect(r.findings.find((f) => f.code === "profile_invalid")?.message).toMatch(/not a TAR on chain 31337/);
  });

  it("a later checkpoint switching to another profile -> profile_changed at that version", async () => {
    const r = await run(withContext(buildWorld(), 2, ROOT_TAR));
    expect(codes(r)).toContain("profile_changed");
    expect(r.firstBroken?.version).toBe(2);
    expect(r.checkpoints.slice(0, 2).every((c) => c.ok)).toBe(true);
  });

  it("a profile updated after registration is reported as a warning", async () => {
    const r = await run(buildWorld(), { profile: profileWorld({ profileVersions: 2 }) });
    expect(r.ok).toBe(true);
    expect(r.findings.find((f) => f.code === "profile_updated")?.severity).toBe("warning");
  });

  it("without a profile source only the @context form is checked", async () => {
    const r = await verifyLog({ ...sources(buildWorld()), now: new Date(Date.UTC(2026, 10, 19, 10, 12)) });
    expect(r.ok).toBe(true);
    expect(r.profile).toBeNull();
  });
});

// ============================================================ reconcile
function reconcileWorld() {
  const w = buildWorld();
  const captured = w.events;
  const auditRows = structuredClone(w.audit);
  let grades = [{ ...auditRows[2]!.new_row! }];
  const src: ReconcileSource = {
    appAuditRows: async () => auditRows.map((r) => ({ ...r, occurred_at: new Date(r.occurred_at) })),
    authAuditRows: async () => [],
    tableRows: async (t) => (t === "app.grades" ? grades : []),
    labels: async () => new Map([[STUDENT, "Driton Shala"], [COURSE, "CS205"]]),
  };
  return { captured, auditRows, src, setGrades: (g: typeof grades) => (grades = g) };
}

describe("reconcile", () => {
  it("clean: source matches what was captured", async () => {
    const { captured, src } = reconcileWorld();
    const r = await reconcile(captured, src);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.capturedEvents).toBe(3);
  });

  it("attack 1: deleted audit row", async () => {
    const { captured, auditRows, src } = reconcileWorld();
    auditRows.splice(1, 1);
    const r = await reconcile(captured, src);
    expect(r.findings.map((f) => f.code)).toEqual(["deleted_audit_row"]);
    expect(r.findings[0]!.message).toMatch(/#2 .*DELETED/);
  });

  it("attack 2: grade changed + matching audit row rewritten", async () => {
    const { captured, auditRows, src, setGrades } = reconcileWorld();
    auditRows[2]!.new_row = { ...auditRows[2]!.new_row!, grade: 10 };
    setGrades([{ ...auditRows[2]!.new_row! }]);
    const r = await reconcile(captured, src);
    const c = r.findings.map((f) => f.code);
    expect(c).toContain("modified_audit_row");
    expect(c).toContain("unexplained_change");
    expect(r.findings.find((f) => f.code === "unexplained_change")!.message).toBe(
      "grade of Driton Shala in CS205 is 10 but the last audited value is 6: no audit record explains the change",
    );
  });

  it("grade changed with triggers bypassed (no audit row at all)", async () => {
    const { captured, src, setGrades } = reconcileWorld();
    setGrades([{ ...gradeRow(3, "UPDATE", 7, 10).new_row! }]);
    const r = await reconcile(captured, src);
    expect(r.findings.map((f) => f.code)).toEqual(["unexplained_change"]);
  });

  it("backdated audit row inserted out of band", async () => {
    const { captured, auditRows, src } = reconcileWorld();
    auditRows.splice(1, 0, { ...gradeRow(2, "UPDATE", 6, 7), id: 2 } as AppAuditRow);
    auditRows[1]!.id = 2;
    // shift: insert a row with an id the collector already passed but never saw
    auditRows.push({ ...gradeRow(3, "UPDATE", 6, 6), id: 0 } as AppAuditRow);
    const r = await reconcile(captured, src);
    expect(r.findings.map((f) => f.code)).toContain("unexplained_audit_row");
  });

  it("rows newer than the collector cursor are pending, not tampering", async () => {
    const { captured, auditRows, src, setGrades } = reconcileWorld();
    auditRows.push(gradeRow(4, "UPDATE", 6, 9));
    setGrades([{ ...gradeRow(4, "UPDATE", 6, 9).new_row! }]);
    const r = await reconcile(captured, src);
    expect(r.findings).toEqual([]);
    expect(r.pendingRows).toBe(1);
  });
});

// ============================================================ verify-event
describe("verify-event", () => {
  const prove = (w: World, selector: Parameters<typeof verifyEvent>[0]["selector"]) => {
    const { chain, payloads, leaves } = sources(w);
    return verifyEvent({ chain, payloads, leaves, selector });
  };

  it("every leaf proves into the latest anchored root; the path is a valid RFC 9162 proof", async () => {
    const w = buildWorld();
    for (let i = 0; i < w.events.length; i++) {
      const r = await prove(w, { index: i });
      expect(r.status, `leaf ${i}`).toBe("included");
      expect(r.anchor?.version).toBe(2);
      expect(r.computedRoot).toBe(w.checkpoints[2]!.rootHash);
      expect(verifyInclusion(fromHex(r.leafHash!), i, r.anchor!.treeSize, r.proof.map(fromHex), fromHex(r.anchor!.rootHash))).toBe(true);
      expect(r.firstSealedIn?.version).toBe(i < 4 ? 0 : i < 9 ? 1 : 2);
    }
  });

  it("finds events by sourceId and by a held copy of the event", async () => {
    const w = buildWorld();
    const bySource = await prove(w, { sourceId: w.events[0]!.sourceId, source: "supabase.app_audit" });
    expect(bySource).toMatchObject({ ok: true, index: 0 });
    const byCopy = await prove(w, { event: structuredClone(w.events[5]) });
    expect(byCopy).toMatchObject({ ok: true, index: 5 });
  });

  it("attack 4: the altered leaf no longer proves into the anchored root", async () => {
    const w = buildWorld();
    const forged = appAuditEvent({ ...w.audit[0]!, new_row: { ...w.audit[0]!.new_row!, grade: 10 } }, 1, new Date(w.events[0]!.capturedAt));
    w.leaves[0] = { index: 0, leafHash: eventLeafHash(forged), event: forged };
    const r = await prove(w, { index: 0 });
    expect(r.status).toBe("not_included");
    expect(r.findings.map((f) => f.code)).toContain("inclusion_failed");
    // and the original copy held by e.g. the professor no longer matches the stored log
    const held = await prove(w, { event: w.events[0] });
    expect(held.status).toBe("mismatch");
    expect(held.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "data.new.grade", before: 6, after: 10 })]));
  });

  it("an event not yet covered by a checkpoint is reported as not anchored", async () => {
    const w = buildWorld();
    const extra = heartbeatEvent("c1", 999, {});
    w.leaves.push({ index: w.leaves.length, leafHash: eventLeafHash(extra), event: extra });
    const r = await prove(w, { index: w.leaves.length - 1 });
    expect(r.status).toBe("not_anchored");
    expect(r.ok).toBe(false);
  });

  it("unknown events are not found; truncated logs cannot produce a proof", async () => {
    const w = buildWorld();
    expect((await prove(w, { sourceId: "nope" })).status).toBe("not_found");
    w.leaves = w.leaves.slice(0, -2);
    expect((await prove(w, { index: 0 })).status).toBe("not_included");
  });
});
