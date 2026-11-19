import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ROOT,
  MerkleTree,
  fromHex,
  hashChildren,
  hashLeaf,
  rootFromInclusionProof,
  toHex,
  verifyConsistency,
  verifyInclusion,
  type Hash,
} from "../src/index";

// ---------------------------------------------------------------- fixtures
/** RFC 6962 / transparency-dev test leaves (testonly/constants.go LeafInputs). */
const LEAF_INPUTS = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(fromHex);

/** transparency-dev testonly/constants.go RootHashes(), indexed by tree size. */
const ROOTS = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

/** transparency-dev NodeHashes() level 0 = leaf hashes of LEAF_INPUTS. */
const LEAF_HASHES = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
  "0298d122906dcfc10892cb53a73992fc5b9f493ea4c9badb27b791b4127a7fe7",
  "07506a85fd9dd2f120eb694f86011e5bb4662e5c415a62917033d4a9624487e7",
  "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
  "4271a26be0d8a84f0bd54c8c302e7cb3a3b5d1fa6780a40bcce2873477dab658",
  "b08693ec2e721597130641e8211e7eedccb4c26413963eee6c1e2ed16ffb1a5f",
  "46f6ffadd3d06a09ff3c5860d2755c8b9819db7df44251788c7d8e3180de8eb1",
];

interface InclusionVector { file: string; leafIdx: number; treeSize: number; root: string; leafHash: string; proof: string[]; desc: string; wantErr: boolean }
interface ConsistencyVector { file: string; size1: number; size2: number; root1: string; root2: string; proof: string[]; desc: string; wantErr: boolean }
const vectors = JSON.parse(readFileSync(new URL("./vectors/transparency-dev.json", import.meta.url), "utf8")) as {
  inclusion: InclusionVector[];
  consistency: ConsistencyVector[];
};

function treeOf(n: number, seed = 0): MerkleTree {
  const t = new MerkleTree();
  for (let i = 0; i < n; i++) t.appendLeaf(new TextEncoder().encode(`leaf-${seed}-${i}`));
  return t;
}

// ------------------------------------------------- naive RFC 6962 reference
// Written straight from the RFC text, recursion over array slices, no caching. Used only to cross-check.
const sha = (...p: Uint8Array[]) => { const h = createHash("sha256"); p.forEach((x) => h.update(x)); return new Uint8Array(h.digest()); };
const k = (n: number) => { let x = 1; while (x * 2 < n) x *= 2; return x; };
function refMth(d: Hash[]): Hash {
  if (d.length === 0) return sha();
  if (d.length === 1) return d[0]!;
  const s = k(d.length);
  return sha(Uint8Array.of(1), refMth(d.slice(0, s)), refMth(d.slice(s)));
}
function refPath(m: number, d: Hash[]): Hash[] {
  if (d.length === 1) return [];
  const s = k(d.length);
  return m < s ? [...refPath(m, d.slice(0, s)), refMth(d.slice(s))] : [...refPath(m - s, d.slice(s)), refMth(d.slice(0, s))];
}
function refSubproof(m: number, d: Hash[], b: boolean): Hash[] {
  if (m === d.length) return b ? [] : [refMth(d)];
  const s = k(d.length);
  return m <= s
    ? [...refSubproof(m, d.slice(0, s), b), refMth(d.slice(s))]
    : [...refSubproof(m - s, d.slice(s), false), refMth(d.slice(0, s))];
}

// ======================================================================= tests
describe("hashing (RFC 6962 §2.1)", () => {
  it("empty tree root = SHA-256('')", () => {
    expect(toHex(EMPTY_ROOT)).toBe(ROOTS[0]);
    expect(toHex(new MerkleTree().root())).toBe(ROOTS[0]);
  });

  it("leaf hash = SHA-256(0x00 || leaf) for the RFC test leaves", () => {
    expect(LEAF_INPUTS.map((l) => toHex(hashLeaf(l)))).toEqual(LEAF_HASHES);
  });

  it("node hash uses the 0x01 prefix (domain separation from leaves)", () => {
    const a = hashLeaf(LEAF_INPUTS[0]!);
    const b = hashLeaf(LEAF_INPUTS[1]!);
    expect(toHex(hashChildren(a, b))).toBe(ROOTS[2]);
    // A leaf whose bytes equal (left || right) must NOT collide with the node.
    expect(toHex(hashLeaf(new Uint8Array([...a, ...b])))).not.toBe(ROOTS[2]);
  });

  it("roots for every size 0..8 match the RFC 6962 vectors (incl. unbalanced trees)", () => {
    const t = new MerkleTree();
    expect(toHex(t.root())).toBe(ROOTS[0]);
    LEAF_INPUTS.forEach((leaf, i) => {
      t.appendLeaf(leaf);
      expect(toHex(t.root()), `size ${i + 1}`).toBe(ROOTS[i + 1]);
    });
    for (let s = 0; s <= 8; s++) expect(toHex(t.root(s))).toBe(ROOTS[s]);
  });
});

describe("transparency-dev/merkle test vectors (RFC 6962)", () => {
  it("has the full vector set", () => {
    expect(vectors.inclusion.length).toBe(98);
    expect(vectors.consistency.length).toBe(98);
  });

  it.each(vectors.inclusion.map((v) => [v.file, v] as const))("inclusion %s", (_f, v) => {
    const ok = verifyInclusion(fromHex(v.leafHash), v.leafIdx, v.treeSize, v.proof.map(fromHex), fromHex(v.root));
    expect(ok, v.desc).toBe(!v.wantErr);
  });

  it.each(vectors.consistency.map((v) => [v.file, v] as const))("consistency %s", (_f, v) => {
    const ok = verifyConsistency(v.size1, v.size2, fromHex(v.root1), fromHex(v.root2), v.proof.map(fromHex));
    expect(ok, v.desc).toBe(!v.wantErr);
  });

  it("our generated proofs equal the vectors' happy-path proofs", () => {
    const t = new MerkleTree();
    LEAF_INPUTS.forEach((l) => t.appendLeaf(l));
    for (const v of vectors.inclusion.filter((x) => !x.wantErr && x.treeSize > 0 && x.treeSize <= 8)) {
      expect(t.inclusionProof(v.leafIdx, v.treeSize).map(toHex), v.file).toEqual(v.proof);
    }
    for (const v of vectors.consistency.filter((x) => !x.wantErr && x.size2 <= 8)) {
      expect(t.consistencyProof(v.size1, v.size2).map(toHex), v.file).toEqual(v.proof);
    }
  });
});

describe("cross-check against a naive RFC reference implementation", () => {
  it("roots, inclusion and consistency proofs agree for every size 1..64", () => {
    const t = treeOf(64);
    const leaves = Array.from({ length: 64 }, (_, i) => t.leafHash(i));
    for (let n = 1; n <= 64; n++) {
      const d = leaves.slice(0, n);
      expect(toHex(t.root(n))).toBe(toHex(refMth(d)));
      for (let m = 0; m < n; m++) expect(t.inclusionProof(m, n).map(toHex)).toEqual(refPath(m, d).map(toHex));
      for (let m = 1; m < n; m++) expect(t.consistencyProof(m, n).map(toHex)).toEqual(refSubproof(m, d, true).map(toHex));
    }
  });
});

describe("properties: every index, every oldSize < newSize", () => {
  const N = 70;
  const t = treeOf(N, 1);

  it("every inclusion proof verifies, for every tree size up to 70", () => {
    for (let n = 1; n <= N; n++) {
      const root = t.root(n);
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(t.leafHash(i), i, n, t.inclusionProof(i, n), root), `i=${i} n=${n}`).toBe(true);
      }
    }
  });

  it("every consistency proof verifies, for every 1 ≤ old ≤ new ≤ 70", () => {
    for (let n = 1; n <= N; n++) {
      for (let m = 1; m <= n; m++) {
        expect(verifyConsistency(m, n, t.root(m), t.root(n), t.consistencyProof(m, n)), `m=${m} n=${n}`).toBe(true);
      }
    }
  });

  it("randomised sizes up to 1000 (deterministic PRNG)", () => {
    let s = 42;
    const rnd = (max: number) => ((s = (s * 1103515245 + 12345) % 2 ** 31), s % max);
    const big = treeOf(1000, 2);
    for (let r = 0; r < 300; r++) {
      const n = 1 + rnd(1000);
      const i = rnd(n);
      const m = 1 + rnd(n);
      expect(verifyInclusion(big.leafHash(i), i, n, big.inclusionProof(i, n), big.root(n))).toBe(true);
      expect(verifyConsistency(m, n, big.root(m), big.root(n), big.consistencyProof(m, n))).toBe(true);
    }
  });
});

describe("negative cases: tampering must fail", () => {
  const n = 23;
  const t = treeOf(n, 3);
  const root = t.root();

  it("tampered leaf: different root, and its old proof no longer verifies", () => {
    for (const victim of [0, 7, 15, 22]) {
      const forged = new MerkleTree();
      for (let i = 0; i < n; i++) {
        forged.appendLeaf(new TextEncoder().encode(i === victim ? `leaf-3-${i}-EDITED` : `leaf-3-${i}`));
      }
      expect(toHex(forged.root())).not.toBe(toHex(root));
      expect(verifyInclusion(forged.leafHash(victim), victim, n, t.inclusionProof(victim, n), root)).toBe(false);
    }
  });

  it("reordered leaves give a different root", () => {
    const leaves = Array.from({ length: n }, (_, i) => t.leafHash(i));
    [leaves[4], leaves[5]] = [leaves[5]!, leaves[4]!];
    expect(toHex(new MerkleTree(leaves).root())).not.toBe(toHex(root));
  });

  it("truncated tree: smaller root differs and cannot pose as the anchored size", () => {
    const truncated = new MerkleTree(Array.from({ length: n - 3 }, (_, i) => t.leafHash(i)));
    expect(toHex(truncated.root())).not.toBe(toHex(root));
    // a proof that the truncated tree extends to the anchored root cannot exist:
    expect(verifyConsistency(n, n - 3, root, truncated.root(), [])).toBe(false);
    expect(verifyConsistency(n - 3, n, truncated.root(), root, truncated.consistencyProof(n - 3, n - 3))).toBe(false);
  });

  it("a history-rewriting fork (drop an old entry, keep the size) is inconsistent with the anchored root", () => {
    const old = treeOf(10, 4);
    const forkLeaves = Array.from({ length: 12 }, (_, i) => (i === 3 ? hashLeaf(new TextEncoder().encode("x")) : treeOf(12, 4).leafHash(i)));
    const fork = new MerkleTree(forkLeaves);
    expect(verifyConsistency(10, 12, old.root(), fork.root(), fork.consistencyProof(10, 12))).toBe(false);
  });

  it("flipping any bit of any proof element fails", () => {
    const proof = t.inclusionProof(9, n);
    for (let p = 0; p < proof.length; p++) {
      const bad = proof.map((x) => new Uint8Array(x));
      bad[p]![0]! ^= 0x01;
      expect(verifyInclusion(t.leafHash(9), 9, n, bad, root)).toBe(false);
    }
    const cproof = t.consistencyProof(11, n);
    for (let p = 0; p < cproof.length; p++) {
      const bad = cproof.map((x) => new Uint8Array(x));
      bad[p]![31]! ^= 0x80;
      expect(verifyConsistency(11, n, t.root(11), root, bad)).toBe(false);
    }
  });

  it("wrong index, wrong size, extra or missing proof elements fail", () => {
    const proof = t.inclusionProof(9, n);
    expect(verifyInclusion(t.leafHash(9), 10, n, proof, root)).toBe(false);
    // NB: n+1 would pass (same proof shape: a root alone does not commit to its size; checkpoints sign
    // treeSize and rootHash together for that reason). n+10 changes the shape and must fail.
    expect(verifyInclusion(t.leafHash(9), 9, n + 10, proof, root)).toBe(false);
    expect(verifyInclusion(t.leafHash(9), 9, n, [...proof, root], root)).toBe(false);
    expect(verifyInclusion(t.leafHash(9), 9, n, proof.slice(1), root)).toBe(false);
    expect(verifyInclusion(t.leafHash(9), n, n, proof, root)).toBe(false);
    expect(rootFromInclusionProof(new Uint8Array(31), 0, 1, [])).toBeNull();
  });

  it("consistency: swapped roots, empty proof, shrinking size fail", () => {
    const p = t.consistencyProof(5, n);
    expect(verifyConsistency(5, n, root, t.root(5), p)).toBe(false);
    expect(verifyConsistency(5, n, t.root(5), root, [])).toBe(false);
    expect(verifyConsistency(n, 5, root, t.root(5), p)).toBe(false);
    expect(verifyConsistency(n, n, root, t.root(5), [])).toBe(false);
    expect(verifyConsistency(0, n, EMPTY_ROOT, root, p)).toBe(false);
    expect(verifyConsistency(0, n, EMPTY_ROOT, root, [])).toBe(false); // from the empty tree proves nothing
  });
});

describe("API guards", () => {
  it("rejects out-of-range arguments and bad leaf hashes", () => {
    const t = treeOf(4);
    expect(() => t.root(5)).toThrow(RangeError);
    expect(() => t.inclusionProof(4, 4)).toThrow(RangeError);
    expect(() => t.consistencyProof(5, 4)).toThrow(RangeError);
    expect(() => t.appendLeafHash(new Uint8Array(31))).toThrow(RangeError);
    expect(t.consistencyProof(0, 4)).toEqual([]);
    expect(t.consistencyProof(4, 4)).toEqual([]);
  });
});
