import { describe, expect, it } from "vitest";
import { jcs, jcsSha256 } from "@vula/core";
import { createRegistryClient, registryConfigFromEnv, waitForTarId } from "../src/registry";

const payload = { "@type": "Test", z: 1, a: { c: "é", b: [3, 2, 1] } };

describe("mock registry (DCAP.Web semantics)", () => {
  it("create -> update -> get by version / receipt", async () => {
    const reg = createRegistryClient({ mode: "mock" });
    const v1 = await reg.create(payload);
    expect(v1.id).toMatch(/^urn:tar:eip155\.31337:[0-9a-f]{40}$/);
    expect(v1.version).toBe(1);
    expect(v1.checksum).toBe(`0x${jcsSha256(payload)}`);

    const v2 = await reg.update(v1.id!, { ...payload, z: 2 });
    expect(v2.version).toBe(2);
    expect(v2.id).toBe(v1.id);

    expect((await reg.get(v1.id!))?.receipt).toBe(v2.receipt);
    expect((await reg.getVersion(v1.id!, 1))?.checksum).toBe(v1.checksum);
    expect((await reg.getByReceipt(v1.receipt))?.version).toBe(1);
    expect(await reg.get("urn:tar:eip155.31337:0000000000000000000000000000000000000000")).toBeNull();
    expect((await waitForTarId(reg, v2.receipt)).id).toBe(v1.id);
  });

  it("update of an unknown TAR fails", async () => {
    const reg = createRegistryClient({ mode: "mock" });
    await expect(reg.update("urn:tar:eip155.31337:0000000000000000000000000000000000000000", {})).rejects.toThrow(/404/);
  });
});

/** Records requests and answers like DCAP.Web does. */
function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (init?.method === "GET" && String(url).includes("/tarId/")) return new Response("", { status: 404 });
    const body = JSON.stringify({
      id: "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3",
      receipt: "a781c353-de57-4171-85ca-5afd51ad610f",
      data: JSON.parse(String(init?.body ?? "{}")),
      checksum: "0x233C42EFBDDA44718E1594E0819A67D15F6A3319C1EDC2E92D2DBA0241A78050",
      version: 1,
      _sdHashes: null,
    });
    return new Response(body, { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

describe("HTTP registry client", () => {
  it("dcap-local: POSTs the JCS text and normalises the response", async () => {
    const f = fakeFetch();
    const reg = createRegistryClient({ mode: "dcap-local", baseUrl: "http://registry:8080/", fetch: f.impl });
    const rec = await reg.create(payload);

    expect(f.calls[0]!.url).toBe("http://registry:8080/api/v1/TAR");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.body).toBe(jcs(payload));
    expect(rec.checksum).toBe("0x233c42efbdda44718e1594e0819a67d15f6a3319c1edc2e92d2dba0241a78050");
    expect(rec.id).toBe("urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Session-Key"]).toBeUndefined();
  });

  it("dcap-local: PUT and version paths keep the TAR id unencoded", async () => {
    const f = fakeFetch();
    const reg = createRegistryClient({ mode: "dcap-local", baseUrl: "http://r", fetch: f.impl });
    const id = "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3";
    await reg.update(id, payload);
    await reg.getVersion(id, 2);
    expect(f.calls[0]!.url).toBe(`http://r/api/v1/TAR/${id}`);
    expect(f.calls[0]!.init.method).toBe("PUT");
    expect(f.calls[1]!.url).toBe(`http://r/api/v1/TAR/version/${id}:2`);
    await expect(reg.get("urn:tar/../../etc")).rejects.toThrow(/unsafe/);
  });

  it("returns null on 404 for GETs", async () => {
    const f = fakeFetch();
    const reg = createRegistryClient({ mode: "dcap-local", fetch: f.impl });
    expect(await reg.getByReceipt("a781c353-de57-4171-85ca-5afd51ad610f")).toBeNull();
  });

  it("gateway: sends the Compellio Gateway headers", async () => {
    const f = fakeFetch();
    const reg = createRegistryClient({
      mode: "gateway",
      apiKey: "k3y",
      network: "etherlink-testnet",
      issuerDomain: "vula.example",
      fetch: f.impl,
    });
    await reg.create(payload);
    expect(f.calls[0]!.url).toBe("https://registry.api.gateway.compellio.com/api/v1/TAR");
    expect(f.calls[0]!.init.headers).toMatchObject({
      "X-Session-Key": "k3y",
      "X-Blockchain": "etherlink-testnet",
      "X-Issuer-Domain": "vula.example",
    });
  });

  it("gateway: refuses to start without an API key", () => {
    expect(() => createRegistryClient({ mode: "gateway" })).toThrow(/GATEWAY_API_KEY/);
  });
});

describe("registryConfigFromEnv", () => {
  it("defaults to dcap-local and validates the mode", () => {
    expect(registryConfigFromEnv({}).mode).toBe("dcap-local");
    expect(() => registryConfigFromEnv({ REGISTRY_MODE: "aws" })).toThrow(/REGISTRY_MODE/);
  });
});
