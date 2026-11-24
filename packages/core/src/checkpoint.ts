import { z } from "zod";
import { jcs, jcsSha256, sha256Hex } from "./jcs";
import { verifyEd25519, type Signer } from "./signing";
import type { VulaEvent } from "./event";

/**
 * CLAUDE.md §7.3. One checkpoint = one TAR version; payload.seq === on-chain version index.
 * `@context` = the TAR id of the VulaCheckpoint TAR profile (profile.ts), as in Compellio's TAR model.
 */
export const CHECKPOINT_TYPE = "VulaCheckpoint";

/** urn:tar:eip155.{chainId}:{contract address}, the form DCAP.Web returns (0x optional). */
export const TAR_ID_PATTERN = /^urn:tar:eip155\.\d+:(?:0x)?[0-9a-fA-F]{40}$/;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

export const checkpointSchema = z
  .object({
    "@context": z.string().regex(TAR_ID_PATTERN, "must be the TAR id of the VulaCheckpoint profile"),
    "@type": z.literal(CHECKPOINT_TYPE),
    logId: z.string().min(1),
    seq: count,
    treeSize: count,
    rootHash: hex64,
    prevTreeSize: count,
    prevRootHash: hex64,
    consistencyProof: z.array(hex64),
    batch: z
      .object({ uri: z.string().min(1), sha256: hex64, fromIndex: count, toIndex: count })
      .strict(),
    issuedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
    signer: z.object({ alg: z.literal("Ed25519"), keyId: z.string().min(1), publicKey: z.string().min(1) }).strict(),
    signature: z.string().min(1),
  })
  .strict();

export type CheckpointPayload = z.infer<typeof checkpointSchema>;
export type UnsignedCheckpoint = Omit<CheckpointPayload, "signature">;

export function parseCheckpoint(x: unknown): CheckpointPayload {
  const r = checkpointSchema.safeParse(x);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid checkpoint: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return r.data;
}

/** The signed message: UTF-8 of JCS(payload without "signature"). */
export function checkpointSigningBytes(p: UnsignedCheckpoint | CheckpointPayload): Uint8Array {
  const { signature: _drop, ...unsigned } = p as CheckpointPayload;
  return new TextEncoder().encode(jcs(unsigned));
}

export function signCheckpoint(unsigned: Omit<UnsignedCheckpoint, "signer">, signer: Signer): CheckpointPayload {
  const withSigner: UnsignedCheckpoint = {
    ...unsigned,
    signer: { alg: signer.alg, keyId: signer.keyId, publicKey: signer.publicKey },
  };
  return { ...withSigner, signature: signer.sign(checkpointSigningBytes(withSigner)) };
}

export function verifyCheckpointSignature(p: CheckpointPayload): boolean {
  return verifyEd25519(p.signer.publicKey, checkpointSigningBytes(p), p.signature);
}

/** TAR checksum of a checkpoint: SHA-256(JCS(payload)), lowercase hex without 0x. */
export function checkpointChecksum(p: CheckpointPayload): string {
  return jcsSha256(p);
}

// ------------------------------------------------------------------- batches
/** The raw events covered by one checkpoint, stored in Supabase Storage. Its SHA-256 is in the payload. */
export interface EventBatch {
  "@type": "VulaEventBatch";
  logId: string;
  fromIndex: number;
  toIndex: number;
  events: VulaEvent[];
}

export function batchBytes(b: EventBatch): Uint8Array {
  return new TextEncoder().encode(jcs(b));
}

export function batchSha256(b: EventBatch): string {
  return sha256Hex(batchBytes(b));
}
