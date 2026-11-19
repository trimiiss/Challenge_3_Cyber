import { createHash, randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { jcs, jcsSha256 } from "@vula/core";
import { formatTarId } from "./tar-id";

/**
 * Compellio Registry API client. Same interface for every mode:
 *   dcap-local  open-source DCAP.Web (synchronous: POST waits for the contract deployment)
 *   gateway     hosted Compellio Gateway Registry API (asynchronous: poll the receipt until the TAR id appears)
 *   mock        in-memory, unit tests only
 *
 * Payloads are always sent as their RFC 8785 (JCS) text. DCAP.Web hashes the raw request body
 * (SHA-256 of JsonDocument.RootElement.ToString()), so sending JCS bytes makes the on-chain checksum
 * equal SHA-256(JCS(payload)), which is the rule every verifier uses.
 */
export type RegistryMode = "dcap-local" | "gateway" | "mock";

export const GATEWAY_DEFAULT_URL = "https://registry.api.gateway.compellio.com/";

/** A TAR record as the Registry API returns it from POST / PUT / GET. */
export interface RegistryRecord {
  /** urn:tar:eip155.{chain}:{address}. Null while a Gateway registration is still pending. */
  id: string | null;
  /** Registry receipt (GUID) for this operation. */
  receipt: string;
  /** SHA-256 the registry computed for the payload, normalised to lowercase 0x-hex. */
  checksum: Hex;
  /**
   * Registry-side version number. DCAP.Web: 1-based local counter (on-chain index = version - 1).
   * Never trust it for anchoring decisions; confirm on-chain with TarReader.waitForChecksum().
   */
  version: number;
  data?: unknown;
}

export interface RegistryClient {
  readonly mode: RegistryMode;
  /** POST /api/v1/TAR: creates a TAR (DCAP.Web deploys a new TAR contract). */
  create(payload: object): Promise<RegistryRecord>;
  /** PUT /api/v1/TAR/{id}: appends a new version (contract push(checksum)). */
  update(tarId: string, payload: object): Promise<RegistryRecord>;
  /** GET /api/v1/TAR/tarId/{receipt}. Null when unknown. */
  getByReceipt(receipt: string): Promise<RegistryRecord | null>;
  /** GET /api/v1/TAR/{tarId}: latest version. Null when unknown. */
  get(tarId: string): Promise<RegistryRecord | null>;
  /** GET /api/v1/TAR/version/{tarId}:{version} (registry-side version numbering). Null when unknown. */
  getVersion(tarId: string, version: number): Promise<RegistryRecord | null>;
}

export interface RegistryConfig {
  mode: RegistryMode;
  /** Registry API base URL. dcap-local default http://localhost:6060, gateway default GATEWAY_DEFAULT_URL. */
  baseUrl?: string;
  /** Gateway only: sent as X-Session-Key. */
  apiKey?: string;
  /** Gateway only: sent as X-Blockchain. */
  network?: string;
  /** Gateway only: sent as X-Issuer-Domain. */
  issuerDomain?: string;
  /** Per-request timeout. DCAP.Web POST blocks on a contract deployment, so keep this generous. */
  timeoutMs?: number;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export function registryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const mode = (env.REGISTRY_MODE ?? "dcap-local") as RegistryMode;
  if (!["dcap-local", "gateway", "mock"].includes(mode)) {
    throw new Error(`REGISTRY_MODE must be dcap-local | gateway | mock, got ${JSON.stringify(mode)}`);
  }
  return {
    mode,
    baseUrl: env.REGISTRY_URL || undefined,
    apiKey: env.GATEWAY_API_KEY || undefined,
    network: env.GATEWAY_NETWORK || undefined,
    issuerDomain: env.GATEWAY_ISSUER_DOMAIN || undefined,
  };
}

export function createRegistryClient(cfg: RegistryConfig): RegistryClient {
  switch (cfg.mode) {
    case "dcap-local":
      return new HttpRegistryClient("dcap-local", cfg.baseUrl ?? "http://localhost:6060", {}, cfg);
    case "gateway": {
      if (!cfg.apiKey) throw new Error("gateway mode needs GATEWAY_API_KEY");
      const headers: Record<string, string> = { "X-Session-Key": cfg.apiKey };
      if (cfg.network) headers["X-Blockchain"] = cfg.network;
      if (cfg.issuerDomain) headers["X-Issuer-Domain"] = cfg.issuerDomain;
      return new HttpRegistryClient("gateway", cfg.baseUrl ?? GATEWAY_DEFAULT_URL, headers, cfg);
    }
    case "mock":
      return new MockRegistryClient();
  }
}

/** Polls GET /tarId/{receipt} until the TAR id appears (Gateway registrations are asynchronous). */
export async function waitForTarId(
  client: RegistryClient,
  receipt: string,
  { timeoutMs = 300_000, intervalMs = 2_000 } = {},
): Promise<RegistryRecord & { id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await client.getByReceipt(receipt);
    if (rec?.id) return rec as RegistryRecord & { id: string };
    if (Date.now() > deadline) throw new RegistryError(`receipt ${receipt} has no TAR id after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function toRecord(raw: unknown): RegistryRecord {
  const r = raw as Record<string, unknown>;
  if (typeof r?.receipt !== "string" || typeof r.checksum !== "string" || typeof r.version !== "number") {
    throw new RegistryError(`unexpected registry response: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  return {
    id: typeof r.id === "string" && r.id.length > 0 ? r.id : null,
    receipt: r.receipt,
    checksum: r.checksum.toLowerCase() as Hex,
    version: r.version,
    data: r.data,
  };
}

function safeTarId(tarId: string): string {
  if (!/^[A-Za-z0-9:._-]+$/.test(tarId)) throw new RegistryError(`refusing unsafe TAR id in URL: ${tarId}`);
  return tarId;
}

class HttpRegistryClient implements RegistryClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    readonly mode: RegistryMode,
    baseUrl: string,
    private readonly headers: Record<string, string>,
    cfg: RegistryConfig,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 180_000;
  }

  private async call(method: string, path: string, payload?: object): Promise<RegistryRecord | null> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json" } : {}),
        ...this.headers,
      },
      body: payload ? jcs(payload) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404 && method === "GET") return null;
    const text = await res.text();
    if (!res.ok) {
      throw new RegistryError(`${method} ${path} -> HTTP ${res.status}`, res.status, text.slice(0, 2000));
    }
    return toRecord(JSON.parse(text));
  }

  async create(payload: object) {
    return (await this.call("POST", "/api/v1/TAR", payload))!;
  }
  // TAR ids go into the path as-is (colons are legal in path segments), exactly like Compellio's BCBCTI client.
  async update(tarId: string, payload: object) {
    return (await this.call("PUT", `/api/v1/TAR/${safeTarId(tarId)}`, payload))!;
  }
  async getByReceipt(receipt: string) {
    return this.call("GET", `/api/v1/TAR/tarId/${encodeURIComponent(receipt)}`);
  }
  async get(tarId: string) {
    return this.call("GET", `/api/v1/TAR/${safeTarId(tarId)}`);
  }
  async getVersion(tarId: string, version: number) {
    return this.call("GET", `/api/v1/TAR/version/${safeTarId(tarId)}:${version}`);
  }
}

/** In-memory registry with DCAP.Web semantics (1-based versions, synchronous ids). Unit tests only. */
class MockRegistryClient implements RegistryClient {
  readonly mode = "mock" as const;
  private readonly tars = new Map<string, RegistryRecord[]>();

  private record(id: string, payload: object, version: number): RegistryRecord {
    const data = JSON.parse(jcs(payload));
    return { id, receipt: randomUUID(), checksum: `0x${jcsSha256(data)}`, version, data };
  }

  async create(payload: object) {
    const address = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 40);
    const id = formatTarId(31337, address);
    const rec = this.record(id, payload, 1);
    this.tars.set(id, [rec]);
    return rec;
  }
  async update(tarId: string, payload: object) {
    const versions = this.tars.get(tarId);
    if (!versions) throw new RegistryError(`PUT /api/v1/TAR/${tarId} -> HTTP 404`, 404);
    const rec = this.record(tarId, payload, versions.length + 1);
    versions.push(rec);
    return rec;
  }
  async getByReceipt(receipt: string) {
    for (const versions of this.tars.values()) {
      const hit = versions.find((r) => r.receipt === receipt);
      if (hit) return hit;
    }
    return null;
  }
  async get(tarId: string) {
    return this.tars.get(tarId)?.at(-1) ?? null;
  }
  async getVersion(tarId: string, version: number) {
    return this.tars.get(tarId)?.find((r) => r.version === version) ?? null;
  }
}
