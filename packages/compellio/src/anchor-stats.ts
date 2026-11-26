import { formatEther } from "viem";
import { chainById, explorerAddressUrl, explorerTxUrl } from "./chains";
import { parseTarId } from "./tar-id";

/**
 * Numbers for the PoC report's "Live numbers" line (docs/poc-report-draft.md §5), computed from one anchoring run:
 * the log server's checkpoint rows, the on-chain version count and the transaction receipts. Pure, so it is unit-tested;
 * `pnpm anchor:report` feeds it live data.
 */

export interface CheckpointRow {
  seq: number;
  treeSize: number;
  status: "pending" | "anchored" | "failed";
  tarVersion: number | null;
  txHash: string | null;
  issuedAt: string;
  anchoredAt: Date | null;
  attempts: number;
}

export interface TxCost {
  gasUsed: bigint;
  /** Wei per gas actually paid (receipt.effectiveGasPrice). */
  effectiveGasPrice: bigint;
}

export interface AnchorStatsInput {
  tarId: string;
  onChainVersions: number;
  checkpoints: CheckpointRow[];
  /** Receipts by tx hash (lowercase or as stored). Missing ones are reported, not guessed. */
  receipts: Record<string, TxCost>;
  /** Count per event source of the ANCHORED leaves (index < last anchored tree size), e.g. { "vula.heartbeat": 900 }. */
  leavesBySource: Record<string, number>;
  /** Configured checkpoint interval; gaps longer than 2x this are listed. */
  intervalMs: number;
}

export interface Distribution {
  n: number;
  median: number;
  p95: number;
  max: number;
}

export interface AnchorStats {
  tarId: string;
  chainId: number;
  explorerTar: string | null;
  onChainVersions: number;
  anchored: number;
  pending: number;
  failed: number;
  /** Checkpoints that needed more than one attempt (retried pushes). */
  retried: number;
  /** DB rows marked anchored but not (yet) on the chain, or the other way round. */
  versionMismatch: boolean;
  treeSize: number;
  events: { total: number; heartbeats: number; other: number; bySource: Record<string, number> };
  run: { from: string | null; to: string | null; hours: number };
  /** Seconds from signing (issuedAt) to the log server seeing the push confirmed on-chain. */
  latencyS: Distribution | null;
  /** Gaps between consecutive anchored checkpoints longer than 2x the interval (laptop sleep, RPC outage, ...). */
  gaps: { afterSeq: number; seconds: number }[];
  gas: {
    creation: bigint | null;
    push: Distribution | null;
    /** Median fee per push in the chain's native currency (XTZ on Etherlink), as a decimal string. */
    feePerPush: string | null;
    totalFees: string;
    missingReceipts: number;
  };
  firstTx: string | null;
  lastTx: string | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

export function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { n: s.length, median, p95: quantile(s, 0.95), max: s.at(-1)! };
}

function receiptFor(receipts: Record<string, TxCost>, tx: string): TxCost | undefined {
  return receipts[tx] ?? receipts[tx.toLowerCase()];
}

export function anchorStats(input: AnchorStatsInput): AnchorStats {
  const { chainId, address } = parseTarId(input.tarId);
  const rows = [...input.checkpoints].sort((a, b) => a.seq - b.seq);
  const anchored = rows.filter((r) => r.status === "anchored" && r.anchoredAt && r.txHash);

  const latency = distribution(
    anchored.map((r) => (r.anchoredAt!.getTime() - Date.parse(r.issuedAt)) / 1000).filter((s) => Number.isFinite(s)),
  );

  const gaps: AnchorStats["gaps"] = [];
  for (let i = 1; i < anchored.length; i++) {
    const s = (anchored[i]!.anchoredAt!.getTime() - anchored[i - 1]!.anchoredAt!.getTime()) / 1000;
    if (s * 1000 > 2 * input.intervalMs) gaps.push({ afterSeq: anchored[i - 1]!.seq, seconds: Math.round(s) });
  }

  let creation: bigint | null = null;
  const pushGas: number[] = [];
  const pushFees: bigint[] = [];
  let totalFees = 0n;
  let missing = 0;
  for (const r of anchored) {
    const rc = receiptFor(input.receipts, r.txHash!);
    if (!rc) {
      missing++;
      continue;
    }
    const fee = rc.gasUsed * rc.effectiveGasPrice;
    totalFees += fee;
    if (r.tarVersion === 0) creation = rc.gasUsed;
    else {
      pushGas.push(Number(rc.gasUsed));
      pushFees.push(fee);
    }
  }
  pushFees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianFee =
    pushFees.length === 0
      ? null
      : pushFees.length % 2
        ? pushFees[pushFees.length >> 1]!
        : (pushFees[(pushFees.length >> 1) - 1]! + pushFees[pushFees.length >> 1]!) / 2n;

  const heartbeats = input.leavesBySource["vula.heartbeat"] ?? 0;
  const total = Object.values(input.leavesBySource).reduce((a, b) => a + b, 0);
  const from = rows[0]?.issuedAt ?? null;
  const toDate = anchored.at(-1)?.anchoredAt ?? null;

  return {
    tarId: input.tarId,
    chainId,
    explorerTar: explorerAddressUrl(chainId, address),
    onChainVersions: input.onChainVersions,
    anchored: anchored.length,
    pending: rows.filter((r) => r.status === "pending").length,
    failed: rows.filter((r) => r.status === "failed").length,
    retried: rows.filter((r) => r.attempts > 1).length,
    versionMismatch: anchored.length !== input.onChainVersions,
    treeSize: anchored.at(-1)?.treeSize ?? 0,
    events: { total, heartbeats, other: total - heartbeats, bySource: input.leavesBySource },
    run: {
      from,
      to: toDate ? toDate.toISOString() : null,
      hours: from && toDate ? Math.round(((toDate.getTime() - Date.parse(from)) / 3_600_000) * 10) / 10 : 0,
    },
    latencyS: latency,
    gaps,
    gas: {
      creation,
      push: distribution(pushGas),
      feePerPush: medianFee === null ? null : formatEther(medianFee),
      totalFees: formatEther(totalFees),
      missingReceipts: missing,
    },
    firstTx: anchored[0] ? explorerTxUrl(chainId, anchored[0].txHash!) ?? anchored[0].txHash : null,
    lastTx: anchored.at(-1) ? explorerTxUrl(chainId, anchored.at(-1)!.txHash!) ?? anchored.at(-1)!.txHash : null,
  };
}

const s1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** The sentence for docs/poc-report-draft.md §5 "Live numbers". */
export function reportLine(s: AnchorStats): string {
  const chain = chainById(s.chainId);
  const currency = chain?.nativeCurrency.symbol ?? "ETH";
  const parts = [
    `TAR id \`${s.tarId}\``,
    `${s.anchored} anchored checkpoints over ${s.run.hours} h`,
    `${s.treeSize} events (${s.events.other} audit events + ${s.events.heartbeats} heartbeats)`,
  ];
  if (s.latencyS) parts.push(`median anchor latency ${s1(s.latencyS.median)} s (p95 ${s1(s.latencyS.p95)} s)`);
  if (s.gas.push) parts.push(`gas per \`push\` ${Math.round(s.gas.push.median).toLocaleString("en-US")} (≈ ${s.gas.feePerPush} ${currency})`);
  if (s.explorerTar) parts.push(`explorer: ${s.explorerTar}`);
  return `**Live numbers (${chain?.name ?? `chain ${s.chainId}`}):** ${parts.join(", ")}.`;
}
