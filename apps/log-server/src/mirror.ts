import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Severity } from "./store";
import type { ProfileConfig, TarConfig } from "./anchor";
import { TAR_MIRROR_BUCKET, parseTarId, publicTarMirrorPrefix } from "@vula/compellio";
import { tarDocument, tarDocumentBody, type TarDocSources } from "./tar-docs";
import type { CheckpointRow } from "./store";

/**
 * PUBLIC Storage bucket that on-chain `dataUri` points to on testnet:
 *   DCAP_URI_PREFIX = {SUPABASE_URL}/storage/v1/object/public/vula-tar/  ->  dataUri(v) = that + 0x{address}
 * `uriPrefix_` is a TAR contract constructor argument, fixed forever, so it must be a URL any outside auditor can
 * fetch. Only checkpoint payloads (hashes, sizes, timestamps, public key) and the two profile documents go here;
 * raw events and batches stay in the private `vula-batches` bucket.
 */
export const MIRROR_BUCKET = TAR_MIRROR_BUCKET;
export const publicMirrorPrefix = publicTarMirrorPrefix;

export interface MirrorTarget {
  /** Public URL prefix the objects are served at (= the DCAP_URI_PREFIX to use). */
  readonly publicPrefix: string;
  /** Upsert `vula-tar/{path}` with this JSON body. */
  put(path: string, body: string): Promise<void>;
}

/** Writes to the public bucket as the `service` Auth user (storage RLS: only that role may write). */
export function supabaseMirrorTarget(url: string, key: string, email: string, password: string): MirrorTarget {
  const client: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true } });
  let signedIn = false;
  return {
    publicPrefix: publicMirrorPrefix(url),
    async put(path, body) {
      if (!signedIn) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(`mirror: could not sign in to Supabase Auth: ${error.message}`);
        signedIn = true;
      }
      const { error } = await client.storage.from(MIRROR_BUCKET).upload(path, Buffer.from(body, "utf8"), {
        upsert: true,
        contentType: "application/json",
        cacheControl: "10", // verifiers see a new version within ~10 s
      });
      if (error) throw new Error(`mirror upload ${MIRROR_BUCKET}/${path} failed: ${error.message}`);
    },
  };
}

export interface MirrorDeps {
  target: MirrorTarget;
  /** Live view of the anchorer (tar, profile, in-memory checkpoints). */
  state: () => { tar: TarConfig | null; profile: ProfileConfig | null; checkpoints: CheckpointRow[] };
  loadCheckpoints: () => Promise<CheckpointRow[]>;
  alert: (kind: string, severity: Severity, title: string, details?: Record<string, unknown>) => Promise<void>;
  /** Warn when the mirror is more than this many log TAR versions behind the chain. */
  maxLag?: number;
  now?: () => number;
}

/**
 * Copies every TAR document to the public bucket after it changes on-chain (new anchored version, new profile).
 * Runs on its own timer and never blocks anchoring: a failed upload is retried with backoff, and a warning alert
 * is raised once the mirror is more than `maxLag` (2) versions behind. Uploads are idempotent upserts.
 */
export class TarMirror {
  /** address -> number of versions in the last uploaded document */
  readonly mirrored = new Map<string, number>();
  private running = false;
  private failures = 0;
  private retryAt = 0;
  private lagAlerted = false;
  lastError: string | null = null;

  constructor(private readonly deps: MirrorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** What should be in the bucket now: address -> expected version count. */
  wanted(): { address: string; versions: number }[] {
    const { tar, profile, checkpoints } = this.deps.state();
    const out: { address: string; versions: number }[] = [];
    if (profile) {
      out.push({ address: parseTarId(profile.rootSchemaTarId).address, versions: 1 });
      out.push({ address: parseTarId(profile.tarId).address, versions: 1 });
    }
    if (tar) {
      const anchored = checkpoints.filter((c) => c.status === "anchored").length;
      if (anchored > 0) out.push({ address: parseTarId(tar.tarId).address, versions: anchored });
    }
    return out;
  }

  /** Log TAR versions anchored on-chain but not yet in the public mirror. */
  lag(): number {
    const { tar } = this.deps.state();
    if (!tar) return 0;
    const w = this.wanted().find((x) => x.address === parseTarId(tar.tarId).address);
    return w ? Math.max(0, w.versions - (this.mirrored.get(w.address) ?? 0)) : 0;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.now() >= this.retryAt) await this.sync();
      await this.checkLag();
    } finally {
      this.running = false;
    }
  }

  private async sync(): Promise<void> {
    const { state, loadCheckpoints, target } = this.deps;
    for (const w of this.wanted()) {
      if (this.mirrored.get(w.address) === w.versions) continue;
      try {
        const s = state();
        const doc = await tarDocument(w.address, { tar: s.tar, profile: s.profile, loadCheckpoints } satisfies TarDocSources);
        if (!doc) continue;
        const path = `0x${w.address.replace(/^0x/, "")}`;
        await target.put(path, tarDocumentBody(doc));
        this.mirrored.set(w.address, doc.versions.length);
        this.failures = 0;
        this.lastError = null;
        console.log(`[mirror] ${doc.tarId}: ${doc.versions.length} version(s) -> ${target.publicPrefix}${path}`);
      } catch (e) {
        this.failures += 1;
        this.lastError = (e as Error).message;
        const wait = Math.min(5_000 * 2 ** Math.min(this.failures - 1, 5), 120_000);
        this.retryAt = this.now() + wait;
        console.error(`[mirror] ${this.lastError} (attempt ${this.failures}, retry in ${Math.round(wait / 1000)} s)`);
        return;
      }
    }
  }

  private async checkLag(): Promise<void> {
    const max = this.deps.maxLag ?? 2;
    const lag = this.lag();
    if (lag > max && !this.lagAlerted) {
      this.lagAlerted = true;
      await this.deps.alert("mirror_lagging", "warning", `Public TAR payload mirror is ${lag} versions behind the chain`, {
        tarId: this.deps.state().tar?.tarId, lag, lastError: this.lastError, bucket: MIRROR_BUCKET,
      });
    } else if (lag <= max && this.lagAlerted) {
      this.lagAlerted = false;
      await this.deps.alert("mirror_caught_up", "info", "Public TAR payload mirror caught up with the chain", {
        tarId: this.deps.state().tar?.tarId,
      });
    }
  }
}
