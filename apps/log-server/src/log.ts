import { MerkleTree, equalHash, toHex } from "@vula/merkle";
import { eventLeafHash, parseEvent, type VulaEvent } from "@vula/core";
import type { Store } from "./store";

export interface IntegrityIssue {
  kind: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * The append-only log. The in-memory Merkle tree is the server's source of truth while it runs; the
 * vula.leaves table is its persistent copy (and is NOT trusted by the verifier).
 */
export class LogService {
  readonly tree = new MerkleTree();
  readonly events: VulaEvent[] = [];
  private readonly seen = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  lastHeartbeatAt: number | null = null;

  constructor(private readonly store: Store) {}

  get size(): number {
    return this.tree.size;
  }

  /** Loads vula.leaves and reports anything that doesn't add up (gaps, hash mismatches, bad events). */
  async init(): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const rows = await this.store.loadLeaves();
    for (const row of rows) {
      if (row.index !== this.tree.size) {
        issues.push({
          kind: "leaf_gap",
          message: `vula.leaves jumps from index ${this.tree.size - 1} to ${row.index}`,
          details: { expected: this.tree.size, found: row.index },
        });
        break;
      }
      let event: VulaEvent;
      try {
        event = parseEvent(row.event);
      } catch (e) {
        issues.push({ kind: "leaf_invalid", message: `leaf ${row.index}: ${(e as Error).message}` });
        break;
      }
      const h = eventLeafHash(event);
      if (!equalHash(h, row.leaf_hash)) {
        issues.push({
          kind: "leaf_hash_mismatch",
          message: `leaf ${row.index}: stored leaf_hash does not match its event`,
          details: { index: row.index, stored: toHex(row.leaf_hash), computed: toHex(h) },
        });
      }
      this.push(event, h);
    }
    return issues;
  }

  private push(event: VulaEvent, leafHash: Uint8Array): number {
    const index = this.tree.appendLeafHash(leafHash);
    this.events.push(event);
    this.seen.set(`${event.source}|${event.sourceId}`, index);
    if (event.source === "vula.heartbeat") this.lastHeartbeatAt = Date.now();
    return index;
  }

  /**
   * Appends validated events in order. Serialised (one append at a time). Re-sent events (same source +
   * sourceId, e.g. after a collector crash) are not appended twice; their existing index is returned.
   */
  append(events: VulaEvent[]): Promise<number[]> {
    const run = this.queue.then(async () => {
      const result: number[] = [];
      const fresh: { index: number; leafHash: string; event: VulaEvent; hash: Uint8Array }[] = [];
      const batchSeen = new Map<string, number>();
      for (const e of events) {
        const key = `${e.source}|${e.sourceId}`;
        const existing = this.seen.get(key) ?? batchSeen.get(key);
        if (existing !== undefined) {
          result.push(existing);
          continue;
        }
        const index = this.tree.size + fresh.length;
        const hash = eventLeafHash(e);
        fresh.push({ index, leafHash: toHex(hash), event: e, hash });
        batchSeen.set(key, index);
        result.push(index);
      }
      await this.store.insertLeaves(fresh.map(({ index, leafHash, event }) => ({ index, leafHash, event })));
      for (const f of fresh) this.push(f.event, f.hash);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
