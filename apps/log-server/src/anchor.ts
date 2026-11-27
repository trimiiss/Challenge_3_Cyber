import type { Hex } from "viem";
import { EMPTY_ROOT, fromHex, toHex } from "@vula/merkle";
import {
  ASSET_SCHEMA_ROOT,
  CHECKPOINT_TYPE,
  checkpointChecksum,
  checkpointProfile,
  jcs,
  jcsSha256,
  signCheckpoint,
  type CheckpointPayload,
  type CheckpointProfile,
  type EventBatch,
  type Signer,
} from "@vula/core";
import {
  createTarReader,
  explorerAddressUrl,
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

/** The VulaCheckpoint TAR profile every checkpoint's `@context` points to (vula.config key `profile`). */
export interface ProfileConfig {
  tarId: string;
  rootSchemaTarId: string;
  chainId: number;
  createdAt: string;
  payload: CheckpointProfile;
}

/** Both profile TARs exist on the RPC's chain and hold exactly the expected documents. */
async function profileOnChain(rpcUrl: string, p: ProfileConfig): Promise<boolean> {
  if (jcs(p.payload) !== jcs(checkpointProfile(p.rootSchemaTarId))) return false;
  for (const [tarId, doc] of [[p.rootSchemaTarId, ASSET_SCHEMA_ROOT], [p.tarId, p.payload]] as const) {
    const r = createTarReader({ rpcUrl, tarId });
    try {
      await r.assertChain();
    } catch (e) {
      if (/^RPC is chain/.test((e as Error).message)) return false;
      throw e;
    }
    if (!(await r.exists())) return false;
    if ((await r.getChecksum(0)).toLowerCase() !== `0x${jcsSha256(doc)}`) return false;
  }
  return true;
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
  profile: ProfileConfig | null = null;
  private profileReady = false;
  private profileRetryAt = 0;
  private pendingRootTarId: string | null = null;
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
    this.profile = await this.deps.store.getConfig<ProfileConfig>("profile");
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
    if (last && (await this.foreignVersions(last))) return;
    const size = this.deps.log.size;
    if (size === 0 || size <= (last?.tree_size ?? 0)) return; // nothing new: no checkpoint (heartbeats keep it moving)
    if (Date.now() - this.lastCheckpointAt < this.deps.intervalMs) return;
    if (!(await this.ensureProfile())) return;
    this.lastCheckpointAt = Date.now();
    const row = await this.createCheckpoint(last, size);
    await this.anchor(row);
  }

  /**
   * Compellio TAR Profiles: before the first checkpoint, register (1) DCAP.Web's root asset schema and (2) the
   * VulaCheckpoint profile pointing to it, one POST at a time. Kept in vula.config and reused while both are still
   * on-chain (they survive `pnpm demo:reset`); re-registered after the chain was wiped or switched.
   */
  private async ensureProfile(): Promise<boolean> {
    if (this.profileReady) return true;
    if (Date.now() < this.profileRetryAt) return false;
    const { store, rpcUrl } = this.deps;
    try {
      if (this.profile && (await profileOnChain(rpcUrl, this.profile))) {
        this.profileReady = true;
        console.log(`[profile] checkpoints use TAR profile ${this.profile.tarId}`);
        return true;
      }
      if (this.tar) {
        // Its checkpoints already point at another (or no) profile: switching now would break the chain of @context.
        this.halted = `TAR ${this.tar.tarId} has no valid TAR profile on this chain (${this.profile?.tarId ?? "created before TAR profiles"}): run pnpm demo:reset`;
        console.error(`[profile] ${this.halted}. Checkpointing halted.`);
        await store.alert("profile_missing", "critical", "The log's TAR profile is not on-chain", {
          tarId: this.tar.tarId, profile: this.profile?.tarId ?? null,
        });
        return false;
      }
      const root = this.pendingRootTarId ?? (await this.registerFixed("root asset schema", ASSET_SCHEMA_ROOT));
      this.pendingRootTarId = root;
      const payload = checkpointProfile(root);
      const tarId = await this.registerFixed("VulaCheckpoint profile", payload);
      this.profile = { tarId, rootSchemaTarId: root, chainId: parseTarId(tarId).chainId, createdAt: new Date().toISOString(), payload };
      await store.setConfig("profile", this.profile);
      this.pendingRootTarId = null;
      this.profileReady = true;
      return true;
    } catch (e) {
      this.profileRetryAt = Date.now() + 30_000;
      this.lastError = `TAR profile: ${(e as Error).message}`;
      console.error(`[profile] ${this.lastError} (retry in 30 s)`);
      return false;
    }
  }

  /** POST a fixed document as a new TAR and wait until its checksum is on-chain. */
  private async registerFixed(label: string, doc: object): Promise<string> {
    const { registry, rpcUrl } = this.deps;
    const rec = await registry.create(doc);
    const tarId = rec.id ?? (await waitForTarId(registry, rec.receipt)).id;
    const reader = createTarReader({ rpcUrl, tarId });
    const checksum = `0x${jcsSha256(doc)}` as Hex;
    const deadline = Date.now() + 180_000;
    while (!(await reader.hasChecksum(checksum).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`${label} ${tarId}: checksum not on-chain after 180 s`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // dataUri is fixed forever in the contract. On a public chain it must not point at this laptop.
    const uri = await reader.dataUri(0).catch(() => "");
    if (reader.chainId !== 31337 && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/i.test(uri)) {
      this.halted = `TAR ${tarId} on chain ${reader.chainId} has dataUri ${uri}: no outside auditor can fetch it. Set DCAP_URI_PREFIX to the public mirror (pnpm testnet use), pnpm infra:up, pnpm demo:reset`;
      await this.deps.store.alert("datauri_not_public", "critical", "TAR dataUri points at localhost on a public chain", { tarId, uri });
      throw new Error(this.halted);
    }
    const link = explorerAddressUrl(reader.chainId, reader.address);
    console.log(`[profile] registered ${label} as TAR ${tarId} (receipt ${rec.receipt})${link ? `  ${link}` : ""}`);
    return tarId;
  }

  private lastForeignCheck = 0;

  /**
   * Only this log server may push to its TAR. If the chain holds versions we never pushed, someone else is
   * anchoring checkpoints in our name (e.g. with a stolen signing key + registry access): halt and alert.
   */
  private async foreignVersions(last: CheckpointRow): Promise<boolean> {
    if (!this.reader || Date.now() - this.lastForeignCheck < 15_000) return false;
    this.lastForeignCheck = Date.now();
    const total = await this.reader.totalVersions();
    const ours = (last.tar_version ?? last.seq) + 1;
    if (total <= ours) return false;
    this.halted = `TAR has ${total} versions on-chain but this log server anchored only ${ours}: foreign checkpoint(s) at version ${ours}..${total - 1}`;
    console.error(`[anchor] ${this.halted}. Checkpointing halted.`);
    await this.deps.store.alert("foreign_tar_version", "critical", "A checkpoint this log server never issued was anchored on its TAR", {
      tarId: this.tar?.tarId, ours, onchain: total, versions: Array.from({ length: total - ours }, (_, i) => ours + i),
    });
    return true;
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
        "@context": this.profile!.tarId,
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
      let fromBlock: bigint | undefined;
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
        fromBlock = head > 2_000n ? head - 2_000n : 0n;
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
