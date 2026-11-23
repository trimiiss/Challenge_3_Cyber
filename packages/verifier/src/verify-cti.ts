import { jcsSha256, sha256Hex } from "@vula/core";
import type { ChainSource } from "./types";

/**
 * Verifies one STIX object that Compellio's BCBCTI registered as a TAR, following BCBCTI's own verification flow
 * (docs/architecture.md, "Verification"):
 *   1. TAR: the checksum anchored on-chain for the latest version = SHA-256 of the payload.
 *   2. Type: the payload is a `StixBundle` TAR holding one STIX `artifact`.
 *   3. Artifact: SHA-256 of the object fetched from artifact.url = artifact.hashes["SHA-256"].
 * The payload host (Registry API) and the object storage are untrusted; only the chain is.
 *
 * Verified live against BCBCTI v1.0.0-rc.3 + DCAP.Web v0.0.5 (docs/compellio-notes.md §7), where three details differ
 * from BCBCTI's docs: DCAP.Web hashes the exact body text it received (BCBCTI's body is not JCS), the type is
 * `stixBundle`, and the artifact hash is base64. So a hash matches if it equals SHA-256 of the exact text or of its
 * JCS form, and artifact hashes are accepted as hex or base64. Both still bind the content we then parse.
 */

export type CtiStep = "tar" | "type" | "artifact" | "verified";

export interface CtiVerification {
  tarId: string;
  version: number | null;
  ok: boolean;
  /** Where it stopped (`verified` when everything matched). */
  step: CtiStep;
  reason: string;
  artifactUrl: string | null;
  object: Record<string, unknown> | null;
}

export interface CtiSources {
  chain: ChainSource;
  /** TAR payload text for a chain version (0-based), from any untrusted host. */
  fetchTarPayload(version: number): Promise<string | null>;
  /** The submitted STIX object's text, from the partner's (permissioned) storage. */
  fetchObject(url: string): Promise<string | null>;
}

const hex = (s: string) => s.toLowerCase().replace(/^0x/, "");

/** SHA-256 as hex, from hex or base64 (BCBCTI writes base64). Null if it is neither. */
function hashHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return hex(v);
  const b = Buffer.from(v, "base64");
  return b.length === 32 && b.toString("base64") === v ? b.toString("hex") : null;
}

/** Parses untrusted text and tells whether `want` is SHA-256 of the exact text or of its JCS form. */
function parseCommitted(text: string, want: string): { value: unknown; ok: boolean; got: string } {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return { value: null, ok: false, got: sha256Hex(text) };
  }
  const raw = sha256Hex(text);
  const canon = jcsSha256(value);
  return { value, ok: raw === want || canon === want, got: canon };
}

export async function verifyCtiTar(src: CtiSources): Promise<CtiVerification> {
  const tarId = src.chain.tarId;
  const fail = (step: CtiStep, version: number | null, reason: string, extra: Partial<CtiVerification> = {}) =>
    ({ tarId, version, ok: false, step, reason, artifactUrl: null, object: null, ...extra }) satisfies CtiVerification;

  const total = await src.chain.totalVersions();
  if (total === 0) return fail("tar", null, "TAR has no versions on-chain");
  const version = total - 1;
  const onchain = hex(await src.chain.getChecksum(version));
  const text = await src.fetchTarPayload(version);
  if (text === null) return fail("tar", version, "TAR payload not retrievable");
  const tar = parseCommitted(text, onchain);
  if (!tar.ok) {
    return fail("tar", version, `TAR payload does not match the on-chain checksum (chain 0x${onchain.slice(0, 16)}…, payload ${tar.got.slice(0, 16)}…)`);
  }

  const p = tar.value as { "@type"?: unknown; bundle?: { objects?: unknown[] } } | null;
  const artifact = p?.bundle?.objects?.[0] as { type?: unknown; url?: unknown; hashes?: Record<string, unknown> } | undefined;
  const type = typeof p?.["@type"] === "string" ? (p["@type"] as string).toLowerCase() : "";
  if (type !== "stixbundle" || p?.bundle?.objects?.length !== 1 || artifact?.type !== "artifact") {
    return fail("type", version, "not a BCBCTI StixBundle TAR with exactly one STIX artifact");
  }
  const url = typeof artifact.url === "string" ? artifact.url : null;
  const want = hashHex(artifact.hashes?.["SHA-256"]);
  if (!url || !want) return fail("type", version, "artifact has no url or SHA-256 hash");

  const objText = await src.fetchObject(url);
  if (objText === null) return fail("artifact", version, `STIX object not retrievable from ${url}`, { artifactUrl: url });
  const obj = parseCommitted(objText, want);
  const object = obj.value && typeof obj.value === "object" ? (obj.value as Record<string, unknown>) : null;
  if (!obj.ok || !object) {
    return fail("artifact", version, `STIX object at ${url} was altered (artifact ${want.slice(0, 16)}…, object ${obj.got.slice(0, 16)}…)`, {
      artifactUrl: url,
      object,
    });
  }
  return {
    tarId,
    version,
    ok: true,
    step: "verified",
    reason: "TAR checksum matches the chain and the STIX object matches the artifact hash",
    artifactUrl: url,
    object,
  };
}
