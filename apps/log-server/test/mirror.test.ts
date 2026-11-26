import { describe, expect, it, vi } from "vitest";
import { checkpointProfile } from "@vula/core";
import { parseTarId, publicTarMirrorPrefix, testnetInfraEnv } from "@vula/compellio";
import { dataUriPayloadSource } from "@vula/verifier/sources";
import { buildServer } from "../src/server";
import { TarMirror, type MirrorTarget } from "../src/mirror";
import type { Anchorer, ProfileConfig, TarConfig } from "../src/anchor";
import type { LogService } from "../src/log";
import type { CheckpointRow } from "../src/store";

const SUPABASE = "https://abcdefghijklmnop.supabase.co";
const PREFIX = publicTarMirrorPrefix(SUPABASE);
const ROOT = "urn:tar:eip155.127823:5fbdb2315678afecb367f032d93f642f64180aa3";
const PROFILE = "urn:tar:eip155.127823:e7f1725e7734ce288f8367e1bb143e90bb3f0512";
const LOG = "urn:tar:eip155.127823:9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";

function world(anchoredCount = 3) {
  const tar: TarConfig = { tarId: LOG, chainId: 127823, createdAt: "2026-11-26T10:00:00.000Z" };
  const profile: ProfileConfig = {
    tarId: PROFILE, rootSchemaTarId: ROOT, chainId: 127823, createdAt: "2026-11-26T10:00:00.000Z", payload: checkpointProfile(ROOT),
  };
  const row = (seq: number, status: CheckpointRow["status"]): CheckpointRow => ({
    seq, tree_size: (seq + 1) * 10, root_hash: Buffer.alloc(32, seq), checksum: Buffer.alloc(32, 0xaa),
    payload: { "@type": "VulaCheckpoint", seq, treeSize: (seq + 1) * 10, rootHash: "ab".repeat(32) } as never,
    status, tar_version: status === "anchored" ? seq : null, tx_hash: null, anchored_at: null, attempts: 0, last_error: null,
  });
  const checkpoints = [...Array.from({ length: anchoredCount }, (_, i) => row(i, "anchored")), row(anchoredCount, "pending")];
  const anchorer = { tar, profile, checkpoints, lastAnchored: checkpoints[anchoredCount - 1], pending: checkpoints.at(-1), halted: null };
  return { tar, profile, checkpoints, anchorer };
}

/** In-memory public bucket: path -> body, served at PREFIX + path. */
function bucket(fail: { next: number } = { next: 0 }) {
  const objects = new Map<string, string>();
  const target: MirrorTarget = {
    publicPrefix: PREFIX,
    put: vi.fn(async (path: string, body: string) => {
      if (fail.next > 0) {
        fail.next--;
        throw new Error("storage 503");
      }
      objects.set(path, body);
    }),
  };
  return { objects, target, fail };
}

function mirrorFor(w: ReturnType<typeof world>, target: MirrorTarget, alerts: string[] = [], clock = { t: 0 }) {
  return new TarMirror({
    target,
    state: () => ({ tar: w.tar, profile: w.profile, checkpoints: w.checkpoints }),
    loadCheckpoints: async () => w.checkpoints,
    alert: async (kind) => void alerts.push(kind),
    now: () => clock.t,
  });
}

describe("public TAR payload mirror (vula-tar)", () => {
  it("mirrors exactly what GET /tar/0x{address} serves, for the log TAR and both profile TARs", async () => {
    const w = world();
    const { objects, target } = bucket();
    await mirrorFor(w, target).tick();
    const app = buildServer({
      log: { size: 0 } as unknown as LogService,
      anchorer: w.anchorer as unknown as Anchorer,
      ingestToken: "t", logId: "test",
      watchdog: () => ({ gapOpen: false, lastHeartbeatAt: null }),
      loadCheckpoints: async () => w.checkpoints,
    });
    for (const tarId of [LOG, PROFILE, ROOT]) {
      const address = parseTarId(tarId).address;
      const res = await app.inject({ method: "GET", url: `/tar/${address}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(objects.get(address)).toBe(res.body);
    }
    const doc = JSON.parse(objects.get(parseTarId(LOG).address)!);
    expect(doc.versions.map((v: { version: number }) => v.version)).toEqual([0, 1, 2]); // pending seq 3 not published
    await app.close();
  });

  it("dataUri(0) = prefix + 0x{address} resolves to the mirrored document (what the verifier fetches)", async () => {
    const w = world();
    const { objects, target } = bucket();
    await mirrorFor(w, target).tick();
    const address = parseTarId(LOG).address;
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url).startsWith(PREFIX) ? String(url).slice(PREFIX.length) : null;
      const body = path ? objects.get(path) : undefined;
      return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const reader = { dataUri: async () => `${PREFIX}${address}` } as never;
      const src = dataUriPayloadSource(reader);
      for (const v of [0, 1, 2]) expect(await src.getPayload(v)).toEqual(w.checkpoints[v]!.payload);
      expect(await src.getPayload(3)).toBeNull();
      expect(src.name).toBe(`${PREFIX}${address}`);
      expect(fetchMock).toHaveBeenCalledWith(`${PREFIX}${address}`, expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uploads only when a TAR gets a new version", async () => {
    const w = world(1);
    const { target } = bucket();
    const m = mirrorFor(w, target);
    await m.tick();
    await m.tick();
    expect(target.put).toHaveBeenCalledTimes(3); // root, profile, log v0
    w.checkpoints[1]!.status = "anchored";
    w.checkpoints[1]!.tar_version = 1;
    await m.tick();
    expect(target.put).toHaveBeenCalledTimes(4);
    expect(m.mirrored.get(parseTarId(LOG).address)).toBe(2);
  });

  it("a failing upload never throws, retries with backoff, and warns once the mirror is > 2 versions behind", async () => {
    const w = world(3);
    const { target, fail } = bucket({ next: 1_000 });
    const alerts: string[] = [];
    const clock = { t: 0 };
    const m = mirrorFor(w, target, alerts, clock);
    await expect(m.tick()).resolves.toBeUndefined();
    expect(m.lastError).toMatch(/storage 503/);
    expect(m.lag()).toBe(3);
    expect(alerts).toEqual(["mirror_lagging"]);
    const calls = (target.put as ReturnType<typeof vi.fn>).mock.calls.length;
    await m.tick(); // still inside the backoff window: no new attempt, no duplicate alert
    expect((target.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(alerts).toEqual(["mirror_lagging"]);
    fail.next = 0;
    clock.t = 10 * 60_000;
    await m.tick();
    expect(m.lag()).toBe(0);
    expect(alerts).toEqual(["mirror_lagging", "mirror_caught_up"]);
  });

  it("lag of 2 or fewer versions does not alert", async () => {
    const w = world(2);
    const { target } = bucket({ next: 1_000 });
    const alerts: string[] = [];
    await mirrorFor(w, target, alerts).tick();
    expect(alerts).toEqual([]);
  });
});

describe("pnpm testnet use: DCAP_URI_PREFIX", () => {
  it("points dataUri at the public vula-tar bucket of the project in SUPABASE_URL, never localhost", () => {
    const testnetFile = "# wallet\nDCAP_PRIVATE_KEY=0xabc\nDCAP_BLOCKCHAIN_URL=https://node.shadownet.etherlink.com\nDCAP_BLOCKCHAIN_ID=127823\nDCAP_URI_PREFIX=http://localhost:4000/tar/\n";
    const env = testnetInfraEnv(testnetFile, `${SUPABASE}/`);
    expect(env).toMatch(/^DCAP_URI_PREFIX=https:\/\/abcdefghijklmnop\.supabase\.co\/storage\/v1\/object\/public\/vula-tar\/$/m);
    expect(env).not.toMatch(/localhost/);
    expect(env).toMatch(/^DCAP_PRIVATE_KEY=0xabc$/m);
    expect(testnetInfraEnv("DCAP_BLOCKCHAIN_ID=127823\n", SUPABASE)).toMatch(/^DCAP_URI_PREFIX=https:.*vula-tar\/$/m);
  });

  it("refuses a non-https or placeholder SUPABASE_URL", () => {
    expect(() => publicTarMirrorPrefix("http://localhost:54321")).toThrow();
    expect(() => publicTarMirrorPrefix("https://<project-ref>.supabase.co/x")).toThrow();
  });
});
