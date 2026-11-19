import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { batchBytes, sha256Hex, type EventBatch } from "@vula/core";

export const BATCH_BUCKET = "vula-batches";

/**
 * Uploads each checkpoint's raw event batch to the private Supabase Storage bucket, signed in as the
 * `service` Auth user (storage RLS only lets that role write). Objects are write-once (no upsert).
 */
export class BatchStore {
  private client: SupabaseClient;
  private signedIn = false;

  constructor(
    private readonly url: string,
    key: string,
    private readonly email: string,
    private readonly password: string,
  ) {
    this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true } });
  }

  private async ensureSession(): Promise<void> {
    if (this.signedIn) return;
    const { error } = await this.client.auth.signInWithPassword({ email: this.email, password: this.password });
    if (error) throw new Error(`log server could not sign in to Supabase Auth: ${error.message}`);
    this.signedIn = true;
  }

  /** Returns the authenticated object URL that goes into the checkpoint payload. */
  /** `epoch` separates logs across demo resets (storage objects are write-once and can't be deleted via SQL). */
  async put(batch: EventBatch, seq: number, epoch: string): Promise<{ uri: string; sha256: string }> {
    await this.ensureSession();
    const bytes = batchBytes(batch);
    const sha256 = sha256Hex(bytes);
    const path = `${batch.logId}/${epoch}/${String(seq).padStart(6, "0")}.json`;
    const { error } = await this.client.storage
      .from(BATCH_BUCKET)
      .upload(path, bytes, { contentType: "application/json", upsert: false });
    if (error && !/exists|duplicate/i.test(error.message)) throw new Error(`batch upload failed: ${error.message}`);
    if (error) {
      // Already uploaded by an earlier attempt for this seq: only fine if it is byte-identical.
      const { data, error: dlErr } = await this.client.storage.from(BATCH_BUCKET).download(path);
      if (dlErr || !data) throw new Error(`batch ${path} exists but cannot be read: ${dlErr?.message}`);
      const existing = sha256Hex(new Uint8Array(await data.arrayBuffer()));
      if (existing !== sha256) throw new Error(`batch ${path} already exists with different content`);
    }
    return { uri: `${this.url}/storage/v1/object/authenticated/${BATCH_BUCKET}/${path}`, sha256 };
  }
}
