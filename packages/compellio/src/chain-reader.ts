import { createPublicClient, http, type Hex } from "viem";
import { tarAbi } from "./abi";
import { parseTarId } from "./tar-id";

export interface TarChainVersion {
  /** On-chain version index. 0-based: the constructor pushes version 0. */
  version: number;
  checksum: Hex;
}

export interface UpdateLog {
  version: number;
  checksum: string;
  txHash: Hex;
  blockNumber: bigint;
}

/**
 * Reads a TAR straight from the chain. This is the auditor's only trust anchor: it needs nothing but an RPC
 * URL and the TAR id (which encodes chain id + contract address).
 */
export function createTarReader(opts: { rpcUrl: string; tarId: string }) {
  const { chainId, address } = parseTarId(opts.tarId);
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const base = { address, abi: tarAbi } as const;

  const reader = {
    tarId: opts.tarId,
    chainId,
    address,

    /** Fails if the RPC serves a different chain than the one the TAR id names. */
    async assertChain(): Promise<void> {
      const actual = await client.getChainId();
      if (actual !== chainId) {
        throw new Error(`RPC is chain ${actual} but TAR ${opts.tarId} lives on chain ${chainId}`);
      }
    },

    blockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },

    async blockTimestamp(blockNumber: bigint): Promise<Date> {
      const b = await client.getBlock({ blockNumber });
      return new Date(Number(b.timestamp) * 1000);
    },

    async totalVersions(): Promise<number> {
      return Number(await client.readContract({ ...base, functionName: "totalVersions" }));
    },

    getChecksum(version: number): Promise<Hex> {
      return client.readContract({ ...base, functionName: "getChecksum", args: [BigInt(version)] });
    },

    /** NB: DCAPv2 ignores the version argument and returns {uriPrefix}{0xcontractAddress} for every version. */
    dataUri(version: number): Promise<string> {
      return client.readContract({ ...base, functionName: "dataUri", args: [BigInt(version)] });
    },

    owner(): Promise<Hex> {
      return client.readContract({ ...base, functionName: "owner" });
    },

    hasChecksum(checksum: Hex): Promise<boolean> {
      return client.readContract({ ...base, functionName: "hasChecksum", args: [checksum] });
    },

    async getVersionOf(checksum: Hex): Promise<number> {
      return Number(await client.readContract({ ...base, functionName: "getVersion", args: [checksum] }));
    },

    /** All versions with their checksums, oldest first. */
    async readAll(): Promise<TarChainVersion[]> {
      const total = await reader.totalVersions();
      const out: TarChainVersion[] = [];
      for (let v = 0; v < total; v++) out.push({ version: v, checksum: await reader.getChecksum(v) });
      return out;
    },

    /** The Updated(version, checksum) event for a version: gives the tx hash for explorer links. */
    async findUpdateLog(version: number, fromBlock: bigint = 0n): Promise<UpdateLog | null> {
      const logs = await client.getContractEvents({
        ...base,
        eventName: "Updated",
        args: { version: BigInt(version) },
        fromBlock,
        toBlock: "latest",
      });
      const log = logs.at(-1);
      if (!log || !log.transactionHash || log.blockNumber === null) return null;
      return {
        version,
        checksum: log.args.checksum ?? "",
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    },

    /**
     * Polls until `checksum` is recorded on-chain and returns its version + tx.
     * DCAP.Web's PUT returns before the push() tx is mined and its own version counter is local,
     * so the chain is the only reliable confirmation.
     */
    async waitForChecksum(
      checksum: Hex,
      { timeoutMs = 120_000, intervalMs = 1_000, fromBlock = 0n } = {},
    ): Promise<UpdateLog> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await reader.hasChecksum(checksum)) {
          const version = await reader.getVersionOf(checksum);
          const log = await reader.findUpdateLog(version, fromBlock);
          if (log) return log;
        }
        if (Date.now() > deadline) throw new Error(`checksum ${checksum} not on-chain after ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
  return reader;
}

export type TarReader = ReturnType<typeof createTarReader>;
