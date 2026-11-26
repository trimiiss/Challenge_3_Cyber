import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_SCHEMA_ROOT, checkpointChecksum, checkpointProfile, jcsSha256, signCheckpoint, type CheckpointPayload } from "@vula/core";
import { verifyLogChainOnly } from "../src/index";
import { LOG_TAR, PROFILE_TAR, ROOT_TAR, buildWorld, codes, profileWorld, sources, type World } from "./world";

// ------------------------------------------------------------------ no-database proof (runVerifyLogChainOnly)
// The real DB module is replaced: any connection attempt fails the test, and loadEnv() reads no .env.
const state = vi.hoisted(() => ({
  connect: vi.fn(() => {
    throw new Error("verify-log --chain-only opened a database connection");
  }),
  readers: new Map<string, { checksums: string[]; uri: string }>(),
}));

vi.mock("@vula/db", async (orig) => {
  const real = await orig<typeof import("@vula/db")>();
  return { ...real, loadEnv: vi.fn(), connect: state.connect };
});

vi.mock("@vula/compellio", async (orig) => {
  const real = await orig<typeof import("@vula/compellio")>();
  return {
    ...real,
    createTarReader: ({ tarId }: { tarId: string }) => {
      const r = state.readers.get(tarId);
      return {
        tarId,
        chainId: real.parseTarId(tarId).chainId,
        address: real.parseTarId(tarId).address,
        assertChain: async () => {},
        exists: async () => state.readers.has(tarId),
        totalVersions: async () => r?.checksums.length ?? 0,
        getChecksum: async (v: number) => {
          const c = r?.checksums[v];
          if (!c) throw new Error("no contract");
          return c;
        },
        dataUri: async () => r?.uri ?? "",
      };
    },
  };
});

const MIRROR = "https://ref.supabase.co/storage/v1/object/public/vula-tar/";
const addr = (tarId: string) => `0x${tarId.split(":").at(-1)}`;

/** Puts the world on a fake chain and its payloads in a fake public mirror served at dataUri. */
function publish(w: World): Map<string, string> {
  const profile = checkpointProfile(ROOT_TAR);
  const docs = new Map<string, string>();
  const put = (tarId: string, checksums: string[], payloads: unknown[]) => {
    const uri = `${MIRROR}${addr(tarId)}`;
    state.readers.set(tarId, { checksums, uri });
    docs.set(uri, JSON.stringify({ tarId, versions: payloads.map((payload, version) => ({ version, payload })) }));
  };
  put(ROOT_TAR, [`0x${jcsSha256(ASSET_SCHEMA_ROOT)}`], [ASSET_SCHEMA_ROOT]);
  put(PROFILE_TAR, [`0x${jcsSha256(profile)}`], [profile]);
  put(LOG_TAR, w.chainChecksums, w.payloadStore);
  return docs;
}

/** Re-signs checkpoint `v` with `change` applied and anchors the result (a key holder forging history). */
function forge(w: World, v: number, change: (p: Omit<CheckpointPayload, "signature" | "signer">) => void) {
  const { signature: _s, signer: _k, ...unsigned } = structuredClone(w.checkpoints[v]!);
  change(unsigned);
  const cp = signCheckpoint(unsigned, w.signer);
  w.payloadStore[v] = cp;
  w.chainChecksums[v] = `0x${checkpointChecksum(cp)}`;
}

const chainOnly = (w: World) => {
  const { chain, payloads } = sources(w);
  return verifyLogChainOnly({ chain, payloads, profile: profileWorld() });
};

describe("verify-log --chain-only (core)", () => {
  it("clean run: every anchored checkpoint verified, no leaves needed", async () => {
    const r = await chainOnly(buildWorld());
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("chain-only");
    expect(r.totalVersions).toBe(3);
    expect(r.verifiedVersions).toBe(3);
    expect(r.anchoredTreeSize).toBe(buildWorld().events.length);
    expect(r.profile).toMatchObject({ tarId: PROFILE_TAR, ok: true });
    expect(r.firstBroken).toBeNull();
    expect(codes(r)).toEqual([]);
  });

  it("altered payload in the mirror -> SHA-256(JCS) no longer matches getChecksum", async () => {
    const w = buildWorld();
    (w.payloadStore[1] as CheckpointPayload).treeSize = 8;
    const r = await chainOnly(w);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("payload_mismatch");
    expect(r.firstBroken?.version).toBe(1);
    expect(r.verifiedVersions).toBe(1);
  });

  it("broken prevRoot link (re-signed and anchored) -> broken_link", async () => {
    const w = buildWorld();
    forge(w, 2, (p) => (p.prevRootHash = "00".repeat(32)));
    const r = await chainOnly(w);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("broken_link");
    expect(r.firstBroken?.version).toBe(2);
  });

  it("bad consistency proof (re-signed and anchored) -> inconsistent", async () => {
    const w = buildWorld();
    forge(w, 2, (p) => (p.consistencyProof = p.consistencyProof.map((h, i) => (i === 0 ? "11".repeat(32) : h))));
    const r = await chainOnly(w);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("inconsistent");
    expect(codes(r)).not.toContain("broken_link");
    expect(r.firstBroken?.version).toBe(2);
  });

  it("missing payloads (unreachable dataUri) fail", async () => {
    const w = buildWorld();
    w.payloadStore = [];
    const r = await chainOnly(w);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("payload_missing");
  });
});

describe("verify-log --chain-only (runner): no database, no .env", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    state.readers.clear();
    state.connect.mockClear();
    for (const k of Object.keys(process.env)) {
      if (/^(SUPABASE_|VULA_|DATABASE_URL|AUDITOR_|CHAIN_RPC_URL)/.test(k) || /_DB_PASSWORD$/.test(k)) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  async function runWith(w: World) {
    const docs = publish(w);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      const body = docs.get(String(url));
      return body ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 });
    });
    const { runVerifyLogChainOnly, closeAuditorDb } = await import("../src/run");
    const r = await runVerifyLogChainOnly({ tar: LOG_TAR, rpc: "https://rpc.example" });
    await closeAuditorDb();
    return { r, fetched };
  }

  it("clean run passes with only --tar and --rpc, payloads via dataUri, and opens NO database connection", async () => {
    const { r, fetched } = await runWith(buildWorld());
    expect(r.ok).toBe(true);
    expect(r.verifiedVersions).toBe(3);
    expect(r.payloadSource).toBe(`${MIRROR}${addr(LOG_TAR)}`);
    expect(fetched).toEqual(expect.arrayContaining([`${MIRROR}${addr(LOG_TAR)}`, `${MIRROR}${addr(PROFILE_TAR)}`]));
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("a tampered mirror fails, still without a database connection", async () => {
    const w = buildWorld();
    (w.payloadStore[2] as CheckpointPayload).rootHash = "22".repeat(32);
    const { r } = await runWith(w);
    expect(r.ok).toBe(false);
    expect(r.firstBroken?.version).toBe(2);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("refuses to run without a TAR id (never falls back to vula.config)", async () => {
    const { runVerifyLogChainOnly } = await import("../src/run");
    await expect(runVerifyLogChainOnly({ rpc: "https://rpc.example" })).rejects.toThrow(/needs the TAR id/);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("the full verify-log would have needed the database (the mock really guards connect)", async () => {
    const { runVerifyLog } = await import("../src/run");
    await expect(runVerifyLog({ tar: LOG_TAR, rpc: "https://rpc.example" })).rejects.toThrow(/opened a database connection/);
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
});
