/**
 * Inputs of the verifier. Only `ChainSource` is trusted. Everything else (payloads, leaves, batches, source
 * rows) is untrusted data that the verifier re-hashes and checks against what is anchored on-chain.
 */
export interface ChainSource {
  readonly tarId: string;
  readonly chainId: number;
  totalVersions(): Promise<number>;
  /** bytes32 checksum as 0x-hex */
  getChecksum(version: number): Promise<string>;
}

export interface PayloadSource {
  readonly name: string;
  getPayload(version: number): Promise<unknown | null>;
}

export interface StoredLeaf {
  index: number;
  leafHash: Uint8Array;
  event: unknown;
}

export interface LeafSource {
  readonly name: string;
  getLeaves(): Promise<StoredLeaf[]>;
}

export interface BatchSource {
  getBatch(uri: string): Promise<Uint8Array | null>;
}

export type Severity = "info" | "warning" | "critical";

export interface Finding {
  /** machine-readable kind, e.g. root_mismatch, leaf_altered, deleted_audit_row */
  code: string;
  severity: Severity;
  message: string;
  layer: "log-vs-chain" | "source-vs-log";
  version?: number;
  index?: number;
  details?: Record<string, unknown>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CheckpointResult {
  version: number;
  seq?: number;
  treeSize?: number;
  rootHash?: string;
  issuedAt?: string;
  ok: boolean;
  checks: Check[];
}

export interface VerifyLogReport {
  ok: boolean;
  tarId: string;
  chainId: number;
  totalVersions: number;
  signerPublicKey: string | null;
  anchoredTreeSize: number;
  storedLeaves: number;
  unanchoredLeaves: number;
  checkpoints: CheckpointResult[];
  firstBroken: { version: number; reason: string } | null;
  findings: Finding[];
}

export interface ReconcileReport {
  ok: boolean;
  capturedEvents: number;
  sourceRows: number;
  pendingRows: number;
  findings: Finding[];
}
