import { describe, expect, it } from "vitest";
import { anchorStats, distribution, reportLine, type CheckpointRow } from "../src/anchor-stats";

const ADDR = "ab".repeat(20);
const SHADOWNET = `urn:tar:eip155.127823:${ADDR}`;
const t0 = Date.parse("2026-12-01T10:00:00Z");
const MIN5 = 300_000;

/** n checkpoints 5 min apart, each confirmed `lat` seconds after signing. */
function run(n: number, lat = 4): CheckpointRow[] {
  return Array.from({ length: n }, (_, seq) => ({
    seq,
    treeSize: (seq + 1) * 20,
    status: "anchored" as const,
    tarVersion: seq,
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    issuedAt: new Date(t0 + seq * MIN5).toISOString(),
    anchoredAt: new Date(t0 + seq * MIN5 + lat * 1000),
    attempts: 1,
  }));
}

const gwei = 1_000_000_000n;
function receipts(rows: CheckpointRow[]) {
  return Object.fromEntries(
    rows.map((r) => [r.txHash!, { gasUsed: r.tarVersion === 0 ? 1_451_292n : 100_020n, effectiveGasPrice: gwei }]),
  );
}

describe("distribution", () => {
  it("median of odd and even counts, p95, max", () => {
    expect(distribution([3, 1, 2])).toEqual({ n: 3, median: 2, p95: 3, max: 3 });
    expect(distribution([4, 1, 2, 3])!.median).toBe(2.5);
    expect(distribution(Array.from({ length: 100 }, (_, i) => i + 1))!.p95).toBe(95);
    expect(distribution([])).toBeNull();
  });
});

describe("anchorStats", () => {
  it("summarises a clean 50-checkpoint Shadownet run", () => {
    const rows = run(50);
    const s = anchorStats({
      tarId: SHADOWNET,
      onChainVersions: 50,
      checkpoints: rows,
      receipts: receipts(rows),
      leavesBySource: { "vula.heartbeat": 900, "supabase.app_audit": 80, "supabase.auth": 20 },
      intervalMs: MIN5,
    });
    expect(s.anchored).toBe(50);
    expect(s.versionMismatch).toBe(false);
    expect(s.treeSize).toBe(1000);
    expect(s.events).toMatchObject({ total: 1000, heartbeats: 900, other: 100 });
    expect(s.latencyS).toMatchObject({ median: 4, max: 4 });
    expect(s.gaps).toEqual([]);
    expect(s.gas.creation).toBe(1_451_292n);
    expect(s.gas.push).toMatchObject({ n: 49, median: 100_020 });
    expect(s.gas.feePerPush).toBe("0.00010002");
    expect(s.gas.missingReceipts).toBe(0);
    expect(s.run.hours).toBe(4.1);
    expect(s.explorerTar).toBe(`https://shadownet.explorer.etherlink.com/address/0x${ADDR}`);
    expect(s.firstTx).toMatch(/^https:\/\/shadownet\.explorer\.etherlink\.com\/tx\/0x0{64}$/);

    const line = reportLine(s);
    expect(line).toContain("Etherlink Shadownet Testnet");
    expect(line).toContain("50 anchored checkpoints over 4.1 h");
    expect(line).toContain("1000 events (100 audit events + 900 heartbeats)");
    expect(line).toContain("median anchor latency 4 s");
    expect(line).toContain("gas per `push` 100,020 (≈ 0.00010002 XTZ)");
  });

  it("flags gaps, retries, unanchored rows, missing receipts and a DB/chain mismatch", () => {
    const rows = run(6);
    // the laptop slept for 20 min before checkpoint 3
    for (const r of rows.slice(3)) r.anchoredAt = new Date(r.anchoredAt!.getTime() + 20 * 60_000);
    rows[2]!.attempts = 3;
    rows.push({ ...rows[5]!, seq: 6, status: "pending", tarVersion: null, txHash: null, anchoredAt: null });
    const rc = receipts(rows.slice(0, 6));
    delete rc[rows[4]!.txHash!];
    const s = anchorStats({
      tarId: SHADOWNET,
      onChainVersions: 7,
      checkpoints: rows,
      receipts: rc,
      leavesBySource: {},
      intervalMs: MIN5,
    });
    expect(s.anchored).toBe(6);
    expect(s.pending).toBe(1);
    expect(s.retried).toBe(1);
    expect(s.versionMismatch).toBe(true);
    expect(s.gaps).toEqual([{ afterSeq: 2, seconds: 1500 }]);
    expect(s.gas.missingReceipts).toBe(1);
    expect(s.gas.push!.n).toBe(4);
  });

  it("local Hardhat has no explorer: raw tx hashes instead of links", () => {
    const rows = run(2);
    const s = anchorStats({
      tarId: `urn:tar:eip155.31337:${ADDR}`,
      onChainVersions: 2,
      checkpoints: rows,
      receipts: {},
      leavesBySource: {},
      intervalMs: 60_000,
    });
    expect(s.explorerTar).toBeNull();
    expect(s.firstTx).toBe(rows[0]!.txHash);
    expect(s.gas.push).toBeNull();
    expect(reportLine(s)).toContain("Hardhat (local)");
  });
});
