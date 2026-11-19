import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Keys sorted by UTF-16 code units, ECMAScript number formatting, minimal string escaping, no whitespace.
 */
export function jcs(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) {
    throw new TypeError("value cannot be canonicalized (undefined, function or symbol)");
  }
  return out;
}

/** SHA-256 as lowercase hex (no 0x). Strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The TAR checksum rule: SHA-256 over the UTF-8 bytes of JCS(value), lowercase hex (no 0x).
 * This is what ends up in the TAR contract via push(bytes32).
 */
export function jcsSha256(value: unknown): string {
  return sha256Hex(jcs(value));
}
