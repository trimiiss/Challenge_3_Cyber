import { MerkleTree, inclusionProofSteps, toHex, type Hash } from "@vula/merkle";
import { diffJson, eventLeafHash, jcs, parseEvent, type FieldChange, type VulaEvent } from "@vula/core";
import { verifyCheckpoints, type AuthenticCheckpoint } from "./verify-log";
import type { ChainSource, Finding, LeafSource, PayloadSource, StoredLeaf } from "./types";

/** Which event to prove: a leaf index, a source id (optionally with its source), or a full event someone holds. */
export type EventSelector =
  | { index: number }
  | { sourceId: string; source?: string }
  | { event: unknown };

export interface VerifyEventOptions {
  chain: ChainSource;
  payloads: PayloadSource;
  leaves: LeafSource;
  selector: EventSelector;
  trustedPublicKey?: string;
}

export interface ProofStep {
  /** 1 = just above the leaf */
  level: number;
  sibling: string;
  /** side of the SIBLING: parent = H(0x01 || sibling || current) when "left" */
  side: "left" | "right";
  parent: string;
}

export type VerifyEventStatus = "included" | "not_included" | "not_anchored" | "not_found" | "mismatch" | "no_anchor";

export interface VerifyEventReport {
  ok: boolean;
  status: VerifyEventStatus;
  message: string;
  tarId: string;
  chainId: number;
  index: number | null;
  event: VulaEvent | null;
  /** SHA-256(0x00 || JCS(event)) recomputed from the event content */
  leafHash: string | null;
  /** the latest authentic anchored checkpoint the proof is checked against */
  anchor: { version: number; seq: number; treeSize: number; rootHash: string; issuedAt: string } | null;
  /** the first anchored checkpoint whose tree contains this leaf ("sealed since") */
  firstSealedIn: { version: number; issuedAt: string } | null;
  proof: string[];
  steps: ProofStep[];
  computedRoot: string | null;
  changes?: FieldChange[];
  findings: Finding[];
}

const LAYER = "log-vs-chain" as const;

/**
 * `vula verify-event` (CLAUDE.md §7.5, stretch): proves that one event is part of the log anchored on-chain.
 *   1. walks the TAR from the chain (same checks as verify-log part A) and takes the latest authentic checkpoint
 *   2. finds the event, recomputes its leaf hash from its CONTENT (never trusts a stored hash)
 *   3. builds the RFC 9162 inclusion proof from the stored log (untrusted) and checks that hashing the leaf up the
 *      proof path reproduces the root anchored on-chain. A single altered byte anywhere on the path breaks it.
 */
export async function verifyEvent(opts: VerifyEventOptions): Promise<VerifyEventReport> {
  const { authentic, findings: chainFindings } = await verifyCheckpoints(opts);
  const base = {
    tarId: opts.chain.tarId, chainId: opts.chain.chainId, index: null, event: null, leafHash: null, anchor: null,
    firstSealedIn: null, proof: [], steps: [], computedRoot: null, findings: chainFindings,
  };
  const latest = authentic.at(-1);
  if (!latest) {
    return { ...base, ok: false, status: "no_anchor", message: chainFindings[0]?.message ?? "the TAR has no authentic checkpoint yet" };
  }
  const anchor = {
    version: latest.version, seq: latest.payload.seq, treeSize: latest.payload.treeSize,
    rootHash: latest.payload.rootHash, issuedAt: latest.payload.issuedAt,
  };

  const stored = (await opts.leaves.getLeaves()).sort((a, b) => a.index - b.index);
  const found = locate(stored, opts.selector);
  if ("error" in found) return { ...base, anchor, ok: false, status: found.status, message: found.error, changes: found.changes, index: found.index ?? null };

  const { index, event } = found;
  const leafHash = eventLeafHash(event);
  const firstSealedIn = sealedIn(authentic, index);
  const withEvent = { ...base, anchor, index, event, leafHash: toHex(leafHash), firstSealedIn };
  if (index >= anchor.treeSize) {
    return {
      ...withEvent, ok: false, status: "not_anchored",
      message: `Event is leaf ${index}, but the latest anchored checkpoint (TAR version ${anchor.version}) covers leaves 0..${anchor.treeSize - 1}: captured, not sealed yet (exposure window until the next checkpoint)`,
    };
  }

  // Proof from the stored log. Leaf hashes are recomputed from content, so a forged leaf_hash column cannot help.
  const hashes: Hash[] = [];
  for (const l of stored.slice(0, anchor.treeSize)) {
    if (l.index !== hashes.length) break;
    hashes.push(l.index === index ? leafHash : safeLeafHash(l));
  }
  if (hashes.length < anchor.treeSize) {
    return {
      ...withEvent, ok: false, status: "not_included",
      message: `The stored log has only ${hashes.length} contiguous leaves but TAR version ${anchor.version} anchored ${anchor.treeSize}: cannot build a proof (log truncated or leaves deleted, run verify-log)`,
    };
  }
  const tree = new MerkleTree(hashes);
  const proof = tree.inclusionProof(index, anchor.treeSize);
  const raw = inclusionProofSteps(leafHash, index, anchor.treeSize, proof) ?? [];
  const steps = raw.map((s, i) => ({ level: i + 1, sibling: toHex(s.sibling), side: s.side, parent: toHex(s.parent) }));
  const computedRoot = steps.at(-1)?.parent ?? toHex(leafHash);
  const ok = computedRoot === anchor.rootHash;
  return {
    ...withEvent, ok, status: ok ? "included" : "not_included",
    proof: proof.map(toHex), steps, computedRoot,
    message: ok
      ? `Leaf ${index} is included in the tree of ${anchor.treeSize} events anchored as TAR version ${anchor.version} (${steps.length} hashes on the proof path)`
      : `Hashing leaf ${index} up its proof path gives ${computedRoot.slice(0, 16)}…, not the root anchored in TAR version ${anchor.version} (${anchor.rootHash.slice(0, 16)}…): this event or the log around it was altered after it was sealed`,
    findings: ok ? chainFindings : [
      ...chainFindings,
      { code: "inclusion_failed", severity: "critical", layer: LAYER, version: anchor.version, index,
        message: `Leaf ${index} does not prove into the root anchored in TAR version ${anchor.version}` },
    ],
  };
}

function safeLeafHash(l: StoredLeaf): Hash {
  try {
    return eventLeafHash(parseEvent(l.event));
  } catch {
    return l.leafHash; // invalid event: the root will not match anyway, verify-log reports it
  }
}

function sealedIn(authentic: AuthenticCheckpoint[], index: number): { version: number; issuedAt: string } | null {
  const a = authentic.find((x) => x.payload.treeSize > index);
  return a ? { version: a.version, issuedAt: a.payload.issuedAt } : null;
}

type Located =
  | { index: number; event: VulaEvent }
  | { error: string; status: "not_found" | "mismatch"; changes?: FieldChange[]; index?: number };

function locate(stored: StoredLeaf[], sel: EventSelector): Located {
  if ("index" in sel) {
    const l = stored.find((x) => x.index === sel.index);
    if (!l) return { status: "not_found", error: `No leaf ${sel.index} in the stored log` };
    try {
      return { index: l.index, event: parseEvent(l.event) };
    } catch (e) {
      return { status: "mismatch", index: l.index, error: `Leaf ${l.index} is not a valid event: ${(e as Error).message}` };
    }
  }
  if ("sourceId" in sel) {
    const l = stored.find((x) => {
      const e = x.event as Partial<VulaEvent> | null;
      return e?.sourceId === sel.sourceId && (!sel.source || e.source === sel.source || e.source === `supabase.${sel.source}`);
    });
    if (!l) return { status: "not_found", error: `No captured event with sourceId ${sel.source ? `${sel.source}:` : ""}${sel.sourceId}` };
    try {
      return { index: l.index, event: parseEvent(l.event) };
    } catch (e) {
      return { status: "mismatch", index: l.index, error: `Leaf ${l.index} is not a valid event: ${(e as Error).message}` };
    }
  }
  // A full event someone holds (e.g. a copy exported earlier): find it by content, else by its id.
  let event: VulaEvent;
  try {
    event = parseEvent(sel.event);
  } catch (e) {
    return { status: "not_found", error: (e as Error).message };
  }
  const text = jcs(event);
  const exact = stored.find((x) => jcs(x.event) === text);
  if (exact) return { index: exact.index, event };
  const same = stored.find((x) => {
    const e = x.event as Partial<VulaEvent> | null;
    return e?.source === event.source && e?.sourceId === event.sourceId;
  });
  if (same) {
    return {
      status: "mismatch", index: same.index, changes: diffJson(event, same.event),
      error: `The log holds a DIFFERENT version of ${event.source}:${event.sourceId} at leaf ${same.index}: the copy you hold and the stored log disagree (prove the stored one by index to see which matches the chain)`,
    };
  }
  return { status: "not_found", error: `Event ${event.source}:${event.sourceId} was never captured in this log` };
}
