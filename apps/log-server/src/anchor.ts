import type { Hex } from "viem";
import { EMPTY_ROOT, fromHex, toHex } from "@vula/merkle";
import {
  CHECKPOINT_CONTEXT,
  CHECKPOINT_TYPE,
  checkpointChecksum,
  signCheckpoint,
  type CheckpointPayload,
  type EventBatch,
  type Signer,
} from "@vula/core";
import {
  createTarReader,
  explorerTxUrl,
  parseTarId,
  waitForTarId,
  type RegistryClient,
  type TarReader,
} from "@vula/compellio";
import type { BatchStore } from "./batches";
import type { LogService } from "./log";
import type { CheckpointRow, Store } from "./store";

export interface TarConfig {
  tarId: string;
  chainId: number;
  createdAt: string;
}

/**
 * Checkpoint + anchor worker (CLAUDE.md §7.3):
 *  - only when there are new leaves; one Registry API request in flight at a time (DCAP.Web is not concurrency safe)
 *  - seq 0: POST creates the TAR; every next seq: PUT -> new TAR version. Invariant: payload.seq == on-chain version
 *  - a failed anchor is retried with backoff using the SAME payload; nothing new is checkpointed until it lands,
 *    so the next checkpoint always chains from the last anchored one and no seq is ever skipped
 *  - confirmation comes from the chain (hasChecksum / Updated event), never from the Registry API response
 */
export class Anchorer {
  private running = false;
  private nextRetryAt = 0;
  private lastCheckpointAt = 0;
  private reader: TarReader | null = null;
  tar: TarConfig | null = null;
  checkpoints: CheckpointRow[] = [];
  halted: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      log: LogService;
      registry: RegistryClient;
      batches: BatchStore;
      signer: Signer;
      logId: string;
      rpcUrl: string;
      intervalMs: number;
    },
  ) {}

  private epoch = "";

  async init(): Promise<void> {
    const epoch = await this.deps.store.getConfig<string>("epoch");
    this.epoch = epoch ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    if (!epoch) await this.deps.store.setConfig("epoch", this.epoch);
    this.tar = await this.deps.store.getConfig<TarConfig>("tar");
    this.checkpoints = await this.deps.store.loadCheckpoints();
    if (this.tar) this.reader = createTarReader({ rpcUrl: this.deps.rpcUrl, tarId: this.tar.tarId });
  }

  get lastAnchored(): CheckpointRow | undefined {
    return this.checkpoints.filter((c) => c.status === "anchored").at(-1);
  }

  get pending(): CheckpointRow | undefined {
    return this.checkpoints.find((c) => c.status !== "anchored");
  }

  async tick(): Promise<void> {
    if (this.running || this.halted) return;
    this.running = true;
    try {
      await this.step();
    } finally {
      this.running = false;
    }
  }

  private async step(): Promise<void> {
    const pending = this.pending;
    if (pending) {
      if (Date.now() >= this.nextRetryAt) await this.anchor(pending);
      return;
    }
    const last = this.lastAnchored;
    const size = this.deps.log.size;
    if (size === 0 || size <= (last?.tree_size ?? 0)) return; // nothing new: no checkpoint (heartbeats keep it moving)
    if (Date.now() - this.lastCheckpointAt < this.deps.intervalMs) return;
    this.lastCheckpointAt = Date.now();
    const row = await this.createCheckpoint(last, size);
    await this.anchor(row);
  }

  private async createCheckpoint(last: CheckpointRow | undefined, size: number): Promise<CheckpointRow> {
    const { log, logId, signer, store, batches } = this.deps;
    const seq = last ? last.seq + 1 : 0;
    const prevTreeSize = last?.tree_size ?? 0;
    const batch: EventBatch = {
      "@type": "VulaEventBatch",
      logId,
      fromIndex: prevTreeSize,
      toIndex: size - 1,
      events: log.events.slice(prevTreeSize, size),
    };
    const stored = await batches.put(batch, seq, this.epoch);
    const payload: CheckpointPayload = signCheckpoint(
      {
        "@context": CHECKPOINT_CONTEXT,
        "@type": CHECKPOINT_TYPE,
        logId,
        seq,
        treeSize: size,
        rootHash: toHex(log.tree.root(size)),
        prevTreeSize,
        prevRootHash: last ? toHex(last.root_hash) : toHex(EMPTY_ROOT),
        consistencyProof: prevTreeSize > 0 ? log.tree.consistencyProof(prevTreeSize, size).map(toHex) : [],
        batch: { uri: stored.uri, sha256: stored.sha256, fromIndex: prevTreeSize, toIndex: size - 1 },
        issuedAt: new Date().toISOString(),
      },
      signer,
    );
    const checksum = Buffer.from(checkpointChecksum(payload), "hex");
    const rootHash = Buffer.from(fromHex(payload.rootHash));
    await store.insertCheckpoint({ seq, treeSize: size, rootHash, payload, checksum });
    const row: CheckpointRow = {
      seq, tree_size: size, root_hash: rootHash, payload, checksum, status: "pending",
      tar_version: null, tx_hash: null, anchored_at: null, attempts: 0, last_error: null,
    };
    this.checkpoints.push(row);
    console.log(`[checkpoint] seq ${seq}: tree ${prevTreeSize} -> ${size}, root ${payload.rootHash.slice(0, 16)}...`);
    return row;
  }

  private async anchor(row: CheckpointRow): Promise<void> {
    const { registry, store, rpcUrl } = this.deps;
    const checksum = `0x${row.checksum.toString("hex")}` as Hex;
    const t0 = Date.now();
    try {
      let fromBlock = 0n;
      if (!this.tar) {
        if (row.seq !== 0) throw new Error(`no TAR yet but checkpoint seq is ${row.seq}`);
        const rec = await registry.create(row.payload);
        const tarId = rec.id ?? (await waitForTarId(registry, rec.receipt)).id;
        this.tar = { tarId, chainId: parseTarId(tarId).chainId, createdAt: new Date().toISOString() };
        await store.setConfig("tar", this.tar);
        this.reader = createTarReader({ rpcUrl, tarId });
        console.log(`[anchor] created TAR ${tarId} (receipt ${rec.receipt})`);
      } else {
        const reader = this.reader!;
        const total = await reader.totalVersions();
        const head = await reader.blockNumber();
        fromBlock = head > 500n ? head - 500n : 0n;
        if (total > row.seq) {
          const onchain = await reader.getChecksum(row.seq);
          if (onchain.toLowerCase() !== checksum) {
            this.halted = `on-chain version ${row.seq} holds ${onchain}, not our checkpoint ${checksum}`;
            await store.alert("chain_conflict", "critical", "TAR already has a different checkpoint at this version", {
              seq: row.seq, onchain, ours: checksum, tarId: this.tar.tarId,
            });
            throw new Error(this.halted);
          }
          // An earlier attempt landed after all; just record it below.
        } else if (total < row.seq) {
          throw new Error(`chain has ${total} versions but next checkpoint is seq ${row.seq}`);
        } else {
          const rec = await registry.update(this.tar.tarId, row.payload);
          console.log(`[anchor] PUT ${this.tar.tarId} -> registry receipt ${rec.receipt}`);
        }
      }
      const log = await this.reader!.waitForChecksum(checksum, { fromBlock, timeoutMs: 180_000 });
      if (log.version !== row.seq) {
        await store.alert("version_mismatch", "critical", "Checkpoint anchored at an unexpected TAR version", {
          seq: row.seq, version: log.version,
        });
      }
      await store.markAnchored(row.seq, log.version, log.txHash);
      Object.assign(row, { status: "anchored", tar_version: log.version, tx_hash: log.txHash, anchored_at: new Date(), last_error: null });
      this.lastError = null;
      const link = explorerTxUrl(this.tar!.chainId, log.txHash) ?? log.txHash;
      console.log(`[anchor] seq ${row.seq} anchored as TAR version ${log.version} in ${Date.now() - t0} ms  ${link}`);
    } catch (e) {
      const msg = (e as Error).message;
      row.attempts += 1;
      row.status = "failed";
      row.last_error = msg;
      this.lastError = msg;
      this.nextRetryAt = Date.now() + Math.min(this.deps.intervalMs * 2 ** Math.min(row.attempts, 4), 5 * 60_000);
      await store.markFailed(row.seq, msg).catch(() => {});
      console.error(`[anchor] seq ${row.seq} attempt ${row.attempts} failed: ${msg}`);
    }
  }
}
