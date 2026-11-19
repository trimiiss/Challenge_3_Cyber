import { describe, expect, it } from "vitest";
import { EMPTY_ROOT, MerkleTree, hashLeaf, toHex } from "@vula/merkle";
import {
  appAuditAction,
  appAuditEvent,
  batchSha256,
  checkpointChecksum,
  checkpointSigningBytes,
  diffJson,
  eventLeafHash,
  generateSigningKey,
  heartbeatEvent,
  jcs,
  jcsSha256,
  leafBytes,
  makeEvent,
  parseCheckpoint,
  parseEvent,
  signCheckpoint,
  signerFromPkcs8,
  verifyCheckpointSignature,
  type AppAuditRow,
  type EventBatch,
} from "../src/index";

const auditRow: AppAuditRow = {
  id: 42,
  occurred_at: new Date("2026-11-19T10:00:00.123Z"),
  table_name: "app.grades",
  op: "UPDATE",
  row_pk: "7d0f3c1e-0000-4000-8000-000000000001",
  old_row: { id: "7d0f3c1e-0000-4000-8000-000000000001", grade: 6 },
  new_row: { id: "7d0f3c1e-0000-4000-8000-000000000001", grade: 7 },
  actor: "11111111-1111-4111-8111-111111111111",
  db_user: "uibm_app",
  txid: 991,
};

describe("event (§7.1)", () => {
  it("makeEvent fills dataSha256 = SHA-256(JCS(data)) and passes validation", () => {
    const e = appAuditEvent(auditRow, 5, new Date("2026-11-19T10:00:05.000Z"));
    expect(e).toMatchObject({
      v: 1,
      source: "supabase.app_audit",
      sourceId: "42",
      seq: 5,
      action: "grade.update",
      target: "app.grades:7d0f3c1e-0000-4000-8000-000000000001",
      actor: "11111111-1111-4111-8111-111111111111",
    });
    expect(e.dataSha256).toBe(jcsSha256(e.data));
    expect(parseEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("leaf = JCS(event), leaf hash = SHA-256(0x00 || leaf)", () => {
    const e = heartbeatEvent("collector-1", 3, { uptimeS: 60 }, new Date("2026-11-19T10:01:00.000Z"));
    expect(new TextDecoder().decode(leafBytes(e))).toBe(jcs(e));
    expect(toHex(eventLeafHash(e))).toBe(toHex(hashLeaf(new TextEncoder().encode(jcs(e)))));
  });

  it("leaf hash is independent of key order / re-serialisation (e.g. a jsonb round trip)", () => {
    const e = appAuditEvent(auditRow, 1);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(e).reverse())));
    expect(toHex(eventLeafHash(parseEvent(reordered)))).toBe(toHex(eventLeafHash(e)));
  });

  it("rejects malformed or inconsistent events", () => {
    const e = appAuditEvent(auditRow, 1);
    expect(() => parseEvent({ ...e, v: 2 })).toThrow(/v/);
    expect(() => parseEvent({ ...e, source: "evil" })).toThrow(/source/);
    expect(() => parseEvent({ ...e, extra: 1 })).toThrow();
    expect(() => parseEvent({ ...e, occurredAt: "yesterday" })).toThrow(/occurredAt/);
    expect(() => parseEvent({ ...e, data: { ...(e.data as object), new: { grade: 10 } } })).toThrow(/dataSha256/);
  });

  it("maps audit actions", () => {
    expect(appAuditAction("app.grades", "INSERT")).toBe("grade.create");
    expect(appAuditAction("app.roles", "INSERT")).toBe("role.grant");
    expect(appAuditAction("app.roles", "DELETE")).toBe("role.revoke");
    expect(appAuditAction("app.logins", "INSERT")).toBe("login");
  });

  it("makeEvent normalises data through JSON (Dates become strings, undefined dropped)", () => {
    const e = makeEvent({
      source: "vula.heartbeat", sourceId: "x", seq: 0, occurredAt: "2026-11-19T10:00:00.000Z",
      capturedAt: "2026-11-19T10:00:00.000Z", actor: null, action: "heartbeat", target: null,
      data: { at: new Date("2026-11-19T10:00:00.000Z"), gone: undefined },
    });
    expect(e.data).toEqual({ at: "2026-11-19T10:00:00.000Z" });
  });
});

describe("checkpoint (§7.3)", () => {
  const key = generateSigningKey();
  const signer = signerFromPkcs8(key.privateKey, "vula-test-1");
  const tree = new MerkleTree();
  const events = Array.from({ length: 5 }, (_, i) => heartbeatEvent("c", i, {}, new Date(1_800_000_000_000 + i * 60_000)));
  events.forEach((e) => tree.appendLeafHash(eventLeafHash(e)));
  const batch: EventBatch = { "@type": "VulaEventBatch", logId: "test-log", fromIndex: 0, toIndex: 4, events };

  const cp = signCheckpoint(
    {
      "@context": "urn:tar:vula:checkpoint:v1",
      "@type": "VulaCheckpoint",
      logId: "test-log",
      seq: 0,
      treeSize: 5,
      rootHash: toHex(tree.root()),
      prevTreeSize: 0,
      prevRootHash: toHex(EMPTY_ROOT),
      consistencyProof: [],
      batch: { uri: "https://example/batch-0.json", sha256: batchSha256(batch), fromIndex: 0, toIndex: 4 },
      issuedAt: "2026-11-19T10:05:00.000Z",
    },
    signer,
  );

  it("signs JCS(payload without signature) with Ed25519 and verifies", () => {
    expect(cp.signer).toEqual({ alg: "Ed25519", keyId: "vula-test-1", publicKey: key.publicKey });
    expect(Buffer.from(cp.signature, "base64")).toHaveLength(64);
    expect(new TextDecoder().decode(checkpointSigningBytes(cp))).not.toContain("signature");
    expect(verifyCheckpointSignature(cp)).toBe(true);
    expect(parseCheckpoint(JSON.parse(JSON.stringify(cp)))).toEqual(cp);
  });

  it("any change to a signed field breaks the signature", () => {
    expect(verifyCheckpointSignature({ ...cp, treeSize: 4 })).toBe(false);
    expect(verifyCheckpointSignature({ ...cp, rootHash: "00".repeat(32) })).toBe(false);
    expect(verifyCheckpointSignature({ ...cp, batch: { ...cp.batch, toIndex: 3 } })).toBe(false);
  });

  it("a different key cannot pass as the signer", () => {
    const other = signerFromPkcs8(generateSigningKey().privateKey, "vula-test-1");
    expect(verifyCheckpointSignature({ ...cp, signer: { ...cp.signer, publicKey: other.publicKey } })).toBe(false);
    expect(verifyCheckpointSignature({ ...cp, signature: "AAAA" })).toBe(false);
  });

  it("checksum = SHA-256(JCS(full payload incl. signature))", () => {
    expect(checkpointChecksum(cp)).toBe(jcsSha256(cp));
    expect(checkpointChecksum(cp)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("schema rejects unknown fields and bad hashes", () => {
    expect(() => parseCheckpoint({ ...cp, extra: true })).toThrow();
    expect(() => parseCheckpoint({ ...cp, rootHash: "XYZ" })).toThrow(/rootHash/);
    expect(() => parseCheckpoint({ ...cp, "@context": "urn:other" })).toThrow();
  });
});

describe("diffJson", () => {
  it("reports changed leaf paths", () => {
    expect(diffJson({ a: 1, n: { grade: 6, x: [1, 2] } }, { a: 1, n: { grade: 10, x: [1, 3] } })).toEqual([
      { path: "n.grade", before: 6, after: 10 },
      { path: "n.x[1]", before: 2, after: 3 },
    ]);
    expect(diffJson({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
