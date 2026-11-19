import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** Ed25519 checkpoint signer. Public key and signature are base64 (raw 32-byte key, 64-byte signature). */
export interface Signer {
  readonly alg: "Ed25519";
  readonly keyId: string;
  readonly publicKey: string;
  sign(message: Uint8Array): string;
}

function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** Generates a new signing key. `privateKey` is PKCS#8 DER, base64 (the format of VULA_SIGNING_KEY). */
export function generateSigningKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: rawPublicKey(publicKey),
  };
}

export function signerFromPkcs8(privateKeyBase64: string, keyId: string): Signer {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`signing key must be Ed25519, got ${key.asymmetricKeyType}`);
  const publicKey = rawPublicKey(createPublicKey(key));
  return {
    alg: "Ed25519",
    keyId,
    publicKey,
    sign: (message) => sign(null, message, key).toString("base64"),
  };
}

export function verifyEd25519(publicKeyBase64: string, message: Uint8Array, signatureBase64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, "base64");
    const sig = Buffer.from(signatureBase64, "base64");
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}
