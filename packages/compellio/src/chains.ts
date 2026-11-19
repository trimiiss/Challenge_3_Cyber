import { defineChain, type Chain } from "viem";

export const hardhatLocal = defineChain({
  id: 31337,
  name: "Hardhat (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:8545"] } },
});

/**
 * Etherlink Shadownet testnet (current Etherlink testnet; Ghostnet / 128123 is retired).
 * viem's built-in `etherlinkTestnet` still points at Ghostnet, hence our own definition.
 * Source: https://docs.etherlink.com/get-started/network-information
 */
export const etherlinkShadownet = defineChain({
  id: 127823,
  name: "Etherlink Shadownet Testnet",
  nativeCurrency: { name: "Tez", symbol: "XTZ", decimals: 18 },
  rpcUrls: { default: { http: ["https://node.shadownet.etherlink.com"] } },
  blockExplorers: {
    default: { name: "Etherlink Shadownet Explorer", url: "https://shadownet.explorer.etherlink.com" },
  },
  testnet: true,
});

const KNOWN: Record<number, Chain> = {
  [hardhatLocal.id]: hardhatLocal,
  [etherlinkShadownet.id]: etherlinkShadownet,
};

export function chainById(id: number): Chain | undefined {
  return KNOWN[id];
}

function explorerBase(chainId: number): string | null {
  return chainById(chainId)?.blockExplorers?.default.url ?? null;
}

/** Block-explorer link for a transaction, or null when the chain has no public explorer (local Hardhat). */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = explorerBase(chainId);
  return base ? `${base}/tx/${txHash}` : null;
}

/** Block-explorer link for the TAR contract, or null when the chain has no public explorer. */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const base = explorerBase(chainId);
  return base ? `${base}/address/${address}` : null;
}
