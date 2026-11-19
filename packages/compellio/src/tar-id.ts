import type { Address } from "viem";

/**
 * TAR id = urn:tar:eip155.{chainId}:{contractAddress}[:{version}]
 * The chain (EIP-155 id) and the contract address are both in the id, so a verifier needs nothing else
 * to find the on-chain record. The address may appear with or without 0x; we accept both.
 */
const TAR_ID_RE = /^urn:tar:eip155\.(\d+):(?:0x)?([0-9a-fA-F]{40})(?::(\d+))?$/;

export interface ParsedTarId {
  chainId: number;
  address: Address;
  /** Optional version suffix as written in the id (DCAP.Web uses it for GET /version/{id}:{v}). */
  version?: number;
}

export function parseTarId(id: string): ParsedTarId {
  const m = TAR_ID_RE.exec(id.trim());
  if (!m) throw new Error(`not a TAR id: ${JSON.stringify(id)}`);
  const parsed: ParsedTarId = {
    chainId: Number(m[1]),
    address: `0x${m[2]!.toLowerCase()}` as Address,
  };
  if (m[3] !== undefined) parsed.version = Number(m[3]);
  return parsed;
}

export function isTarId(id: string): boolean {
  return TAR_ID_RE.test(id.trim());
}

/** Formats a TAR id in the form DCAP.Web returns: lowercase address, no 0x. */
export function formatTarId(chainId: number, address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`bad contract address: ${address}`);
  return `urn:tar:eip155.${chainId}:${hex}`;
}
