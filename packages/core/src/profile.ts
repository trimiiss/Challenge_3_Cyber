import { jcs } from "./jcs";
import { CHECKPOINT_TYPE, TAR_ID_PATTERN } from "./checkpoint";

/**
 * TAR Profiles (Compellio model, DCAP.Web README "Data initialization"; BlockJump Getting Started guide v1.1):
 * a record's `@context` points to a TAR that describes its type. Two TARs are registered once per chain:
 *
 *   root asset schema TAR  <- @context[0] of ->  VulaCheckpoint profile TAR  <- @context of ->  every checkpoint
 *
 * Both documents are fixed here, so a verifier knows their exact content and only needs the chain to check them:
 * SHA-256(JCS(document)) must equal getChecksum(0) of the TAR.
 */

/** DCAP.Web README, "Root profile asset schema", verbatim. */
export const ASSET_SCHEMA_ROOT = {
  "@context": {
    "@version": 1.1,
    foaf: "http://xmlns.com/foaf/0.1/",
    schema: "http://schema.org/",
    skos: "http://www.w3.org/2004/02/skos/core#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    organization_key: {
      "@id": "https://gateway.satp.ietf.org/asset_schema_org_key",
      "@context": {
        public_key: { "@id": "https://gateway.satp.ietf.org/asset_schema_pub_key", "@type": "schema:string" },
        issued: { "@id": "https://gateway.satp.ietf.org/asset_schema_key_issued", "@type": "schema:string" },
      },
    },
    qualities: { "@id": "https://gateway.satp.ietf.org/asset_schema_qualities" },
  },
  "@id": "https://gateway.satp.ietf.org/asset_schema/",
} as const;

export const CHECKPOINT_PROFILE_ID = "urn:vula:asset_profile:checkpoint:v1";

/** Prefixes (`schema:`, `xsd:`) come from the root asset schema, which is the first entry of the `@context`. */
export function checkpointProfile(rootSchemaTarId: string) {
  const term = (name: string, type?: string, extra: Record<string, unknown> = {}) => ({
    "@id": `vula:${name}`,
    ...(type ? { "@type": type } : {}),
    ...extra,
  });
  return {
    "@context": [
      rootSchemaTarId,
      {
        "@version": 1.1,
        asset_schema: "https://gateway.satp.ietf.org/asset_schema/",
        vula: "urn:vula:checkpoint:v1#",
        [CHECKPOINT_TYPE]: { "@id": `vula:${CHECKPOINT_TYPE}` },
        logId: term("logId", "xsd:string"),
        seq: term("seq", "xsd:nonNegativeInteger"),
        treeSize: term("treeSize", "xsd:nonNegativeInteger"),
        rootHash: term("rootHash", "xsd:hexBinary"),
        prevTreeSize: term("prevTreeSize", "xsd:nonNegativeInteger"),
        prevRootHash: term("prevRootHash", "xsd:hexBinary"),
        consistencyProof: term("consistencyProof", "xsd:hexBinary", { "@container": "@list" }),
        batch: term("batch", undefined, {
          "@context": {
            uri: term("batchUri", "@id"),
            sha256: term("batchSha256", "xsd:hexBinary"),
            fromIndex: term("fromIndex", "xsd:nonNegativeInteger"),
            toIndex: term("toIndex", "xsd:nonNegativeInteger"),
          },
        }),
        issuedAt: term("issuedAt", "xsd:dateTime"),
        signer: term("signer", undefined, {
          "@context": {
            alg: term("signatureAlgorithm", "xsd:string"),
            keyId: term("keyId", "xsd:string"),
            publicKey: term("publicKey", "xsd:base64Binary"),
          },
        }),
        signature: term("signature", "xsd:base64Binary"),
      },
    ],
    "@id": CHECKPOINT_PROFILE_ID,
    "schema:name": "Vula checkpoint",
    "schema:version": "1",
    "schema:description":
      "A signed tree head of one Vula tamper-evident audit log. Every checkpoint is one version of the log's TAR. " +
      "Merkle tree: RFC 9162 section 2.1 (leaf = SHA-256(0x00 || JCS(event)), node = SHA-256(0x01 || left || right)); " +
      "consistencyProof proves prevTreeSize -> treeSize is append-only; signature = Ed25519 over JCS(checkpoint without " +
      "signature); TAR checksum = SHA-256(JCS(checkpoint)) (RFC 8785).",
  };
}

export type CheckpointProfile = ReturnType<typeof checkpointProfile>;

/** Is `x` exactly the VulaCheckpoint profile document (for some root schema TAR id)? */
export function matchCheckpointProfile(x: unknown): { ok: true; rootSchemaTarId: string } | { ok: false; reason: string } {
  const ctx = (x as { "@context"?: unknown } | null)?.["@context"];
  const root = Array.isArray(ctx) ? ctx[0] : undefined;
  if (typeof root !== "string" || !TAR_ID_PATTERN.test(root)) {
    return { ok: false, reason: "@context[0] is not the TAR id of a root asset schema" };
  }
  if (jcs(x) !== jcs(checkpointProfile(root))) {
    return { ok: false, reason: `not the ${CHECKPOINT_PROFILE_ID} profile document` };
  }
  return { ok: true, rootSchemaTarId: root };
}

/** Chain id encoded in a TAR id (urn:tar:eip155.{chainId}:{address}). */
export function tarIdChainId(tarId: string): number | null {
  const m = /^urn:tar:eip155\.(\d+):/.exec(tarId);
  return m ? Number(m[1]) : null;
}
