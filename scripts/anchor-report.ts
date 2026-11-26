/**
 * Live numbers of the current anchoring run, for the PoC report (docs/poc-report-draft.md §5) and the
 * "≥ 50 anchored checkpoints" checklist item (CLAUDE.md §11). Read-only: auditor DB role + chain RPC.
 *
 *   pnpm anchor:report           human summary + the report sentence
 *   pnpm anchor:report --json    machine output
 *
 * Exit code 1 if the chain and the checkpoint table disagree, a receipt is missing, or fewer than 50 checkpoints
 * are anchored (so it doubles as the "is the testnet run done?" check).
 */
import { anchorStats, createTarReader, reportLine, type CheckpointRow, type TxCost } from "@vula/compellio";
import { auditorDb, closeAuditorDb, resolveTarId } from "@vula/verifier/run";
import { createPublicClient, http, type Hex } from "viem";

const TARGET = 50;
const json = process.argv.includes("--json");
const sql = auditorDb();
try {
  const { tarId, pinned } = await resolveTarId(sql);
  const rpcUrl = process.env.CHAIN_RPC_URL || "http://localhost:8545";
  const reader = createTarReader({ rpcUrl, tarId });
  await reader.assertChain();
  const onChainVersions = await reader.totalVersions();

  const rows = await sql<
    { seq: string; tree_size: string; status: CheckpointRow["status"]; tar_version: string | null; tx_hash: string | null;
      issued_at: string; anchored_at: Date | null; attempts: number }[]
  >`select seq, tree_size, status, tar_version, tx_hash, payload ->> 'issuedAt' as issued_at, anchored_at, attempts
    from vula.checkpoints order by seq`;
  const checkpoints: CheckpointRow[] = rows.map((r) => ({
    seq: Number(r.seq),
    treeSize: Number(r.tree_size),
    status: r.status,
    tarVersion: r.tar_version === null ? null : Number(r.tar_version),
    txHash: r.tx_hash,
    issuedAt: r.issued_at,
    anchoredAt: r.anchored_at,
    attempts: r.attempts,
  }));

  const anchoredSize = checkpoints.filter((c) => c.status === "anchored").at(-1)?.treeSize ?? 0;
  const bySource = await sql<{ source: string; n: string }[]>`
    select event ->> 'source' as source, count(*) as n from vula.leaves where index < ${anchoredSize} group by 1 order by 1`;

  const client = createPublicClient({ transport: http(rpcUrl) });
  const receipts: Record<string, TxCost> = {};
  for (const c of checkpoints) {
    if (!c.txHash) continue;
    try {
      const r = await client.getTransactionReceipt({ hash: c.txHash as Hex });
      receipts[c.txHash] = { gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
    } catch {
      /* counted as missingReceipts */
    }
  }

  const s = anchorStats({
    tarId,
    onChainVersions,
    checkpoints,
    receipts,
    leavesBySource: Object.fromEntries(bySource.map((b) => [b.source, Number(b.n)])),
    intervalMs: Number(process.env.CHECKPOINT_INTERVAL_MS ?? 60_000),
  });

  const problems: string[] = [];
  if (s.versionMismatch) problems.push(`chain has ${s.onChainVersions} versions but ${s.anchored} checkpoints are anchored in the DB`);
  if (s.gas.missingReceipts) problems.push(`${s.gas.missingReceipts} tx receipts not found on ${rpcUrl}`);
  if (s.anchored < TARGET) problems.push(`${s.anchored}/${TARGET} checkpoints anchored so far`);

  if (json) {
    console.log(JSON.stringify({ ...s, pinned, problems }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    const d = (x: { median: number; p95: number; max: number } | null, unit: string) =>
      x ? `median ${x.median.toFixed(1)}${unit} · p95 ${x.p95.toFixed(1)}${unit} · max ${x.max.toFixed(1)}${unit}` : "-";
    console.log(`TAR          ${s.tarId}${pinned ? "" : "  (id from vula.config; pin with VULA_TAR_ID)"}`);
    console.log(`explorer     ${s.explorerTar ?? "(no public explorer)"}`);
    console.log(`checkpoints  ${s.anchored} anchored · ${s.pending} pending · ${s.failed} failed · ${s.retried} retried · chain: ${s.onChainVersions} versions`);
    console.log(`run          ${s.run.from ?? "-"} → ${s.run.to ?? "-"}  (${s.run.hours} h)`);
    console.log(`events       ${s.treeSize} anchored leaves: ${Object.entries(s.events.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
    console.log(`latency      ${d(s.latencyS, " s")}  (signed → confirmed on-chain)`);
    console.log(`gas          creation ${s.gas.creation ?? "-"} · push ${d(s.gas.push, "")} · fee/push ${s.gas.feePerPush ?? "-"} · total ${s.gas.totalFees}`);
    console.log(`first / last ${s.firstTx ?? "-"}\n             ${s.lastTx ?? "-"}`);
    if (s.gaps.length) console.log(`gaps         ${s.gaps.map((g) => `after seq ${g.afterSeq}: ${g.seconds} s`).join(" · ")}`);
    console.log(`\n${reportLine(s)}\n`);
    for (const p of problems) console.log(`⚠️  ${p}`);
    if (!problems.length) console.log("✅ run complete: chain and checkpoint table agree, all receipts found");
  }
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
  console.error(`❌ ${msg}\n   (is the chain at CHAIN_RPC_URL=${process.env.CHAIN_RPC_URL ?? "http://localhost:8545"} up, and is .env set?)`);
  process.exitCode = 2;
} finally {
  await closeAuditorDb();
}
