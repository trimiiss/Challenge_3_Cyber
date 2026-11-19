/**
 * Merkle tree per RFC 6962 / RFC 9162 §2.1 (Certificate Transparency). Own implementation, no Merkle library.
 *
 *   leaf hash  = SHA-256(0x00 || leaf bytes)
 *   node hash  = SHA-256(0x01 || left || right)
 *   MTH({})    = SHA-256("")
 *   MTH(D[n])  = node(MTH(D[0:k]), MTH(D[k:n]))   with k = largest power of two < n
 *
 * Proof arrays are ordered bottom-up (sibling nearest the leaf first), exactly as in the RFC.
 */
import { createHash } from "node:crypto";

export type Hash = Uint8Array;

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function sha256(...parts: Uint8Array[]): Hash {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Root of the empty tree: SHA-256 of the empty string. */
export const EMPTY_ROOT: Hash = sha256();

export function hashLeaf(leafBytes: Uint8Array): Hash {
  return sha256(LEAF_PREFIX, leafBytes);
}

export function hashChildren(left: Hash, right: Hash): Hash {
  return sha256(NODE_PREFIX, left, right);
}

export function equalHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Largest power of two strictly smaller than n (n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
const half = (n: number) => Math.floor(n / 2);
const odd = (n: number) => n % 2 === 1;

function assertSize(name: string, v: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new RangeError(`${name}=${v} out of range [0, ${max}]`);
}

/** Append-only Merkle tree over leaf hashes. Hashes of complete subtrees are cached (they never change). */
export class MerkleTree {
  private readonly leaves: Hash[] = [];
  private readonly cache = new Map<string, Hash>();

  constructor(leafHashes: Iterable<Hash> = []) {
    for (const h of leafHashes) this.appendLeafHash(h);
  }

  get size(): number {
    return this.leaves.length;
  }

  /** Appends raw leaf bytes (hashed with the 0x00 prefix). Returns the new leaf's index. */
  appendLeaf(leafBytes: Uint8Array): number {
    return this.appendLeafHash(hashLeaf(leafBytes));
  }

  /** Appends an already computed leaf hash. Returns the new leaf's index. */
  appendLeafHash(leafHash: Hash): number {
    if (leafHash.length !== 32) throw new RangeError(`leaf hash must be 32 bytes, got ${leafHash.length}`);
    this.leaves.push(leafHash);
    return this.leaves.length - 1;
  }

  leafHash(index: number): Hash {
    assertSize("index", index, this.size - 1);
    return this.leaves[index]!;
  }

  /** MTH of the first `size` leaves (default: the whole tree). */
  root(size: number = this.size): Hash {
    assertSize("size", size, this.size);
    return size === 0 ? EMPTY_ROOT : this.mth(0, size);
  }

  /** RFC 9162 §2.1.3.1 PATH(index, D[size]). */
  inclusionProof(index: number, size: number = this.size): Hash[] {
    assertSize("size", size, this.size);
    if (!Number.isSafeInteger(index) || index < 0 || index >= size) {
      throw new RangeError(`index=${index} not in tree of size ${size}`);
    }
    return this.path(index, 0, size);
  }

  /** RFC 9162 §2.1.4.1 PROOF(oldSize, D[newSize]). Empty when oldSize is 0 or equals newSize. */
  consistencyProof(oldSize: number, newSize: number = this.size): Hash[] {
    assertSize("newSize", newSize, this.size);
    assertSize("oldSize", oldSize, newSize);
    if (oldSize === 0 || oldSize === newSize) return [];
    return this.subproof(oldSize, 0, newSize, true);
  }

  private mth(start: number, n: number): Hash {
    if (n === 1) return this.leaves[start]!;
    const complete = isPow2(n);
    const key = `${start}:${n}`;
    if (complete) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }
    const k = splitPoint(n);
    const h = hashChildren(this.mth(start, k), this.mth(start + k, n - k));
    if (complete) this.cache.set(key, h);
    return h;
  }

  private path(m: number, start: number, n: number): Hash[] {
    if (n === 1) return [];
    const k = splitPoint(n);
    return m < k
      ? [...this.path(m, start, k), this.mth(start + k, n - k)]
      : [...this.path(m - k, start + k, n - k), this.mth(start, k)];
  }

  private subproof(m: number, start: number, n: number, completeSubtree: boolean): Hash[] {
    if (m === n) return completeSubtree ? [] : [this.mth(start, n)];
    const k = splitPoint(n);
    return m <= k
      ? [...this.subproof(m, start, k, completeSubtree), this.mth(start + k, n - k)]
      : [...this.subproof(m - k, start + k, n - k, false), this.mth(start, k)];
  }
}

/**
 * RFC 9162 §2.1.3.2: recomputes the root from an inclusion proof. Returns null if the proof is malformed
 * for (index, size).
 */
export function rootFromInclusionProof(leafHash: Hash, index: number, size: number, proof: Hash[]): Hash | null {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return null;
  if (leafHash.length !== 32 || proof.some((p) => p.length !== 32)) return null;
  let fn = index;
  let sn = size - 1;
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0) return null;
    if (odd(fn) || fn === sn) {
      r = hashChildren(p, r);
      if (!odd(fn)) {
        while (!odd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      r = hashChildren(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 ? r : null;
}

export function verifyInclusion(leafHash: Hash, index: number, size: number, proof: Hash[], root: Hash): boolean {
  const r = rootFromInclusionProof(leafHash, index, size, proof);
  return r !== null && equalHash(r, root);
}

/**
 * RFC 9162 §2.1.4.2: is the tree of size `newSize` (newRoot) an append-only extension of oldSize (oldRoot)?
 * oldSize must be ≥ 1: a "proof" from the empty tree proves nothing, so it is rejected (as in transparency-dev).
 * Callers special-case the very first checkpoint.
 */
export function verifyConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: Hash,
  newRoot: Hash,
  proof: Hash[],
): boolean {
  if (!Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize) || oldSize < 1 || newSize < oldSize) {
    return false;
  }
  if (oldSize === newSize) return proof.length === 0 && equalHash(oldRoot, newRoot);
  if (proof.length === 0) return false;
  if (proof.some((p) => p.length !== 32)) return false;

  const path = isPow2(oldSize) ? [oldRoot, ...proof] : proof;
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (odd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = hashChildren(c, fr);
      sr = hashChildren(c, sr);
      if (!odd(fn)) {
        while (!odd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      sr = hashChildren(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equalHash(fr, oldRoot) && equalHash(sr, newRoot);
}

export function toHex(h: Uint8Array): string {
  return Buffer.from(h).toString("hex");
}

export function fromHex(s: string): Hash {
  const clean = s.replace(/^0x/, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error(`bad hex: ${s.slice(0, 20)}`);
  return new Uint8Array(Buffer.from(clean, "hex"));
}
