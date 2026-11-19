import { describe, expect, it } from "vitest";
import { formatTarId, isTarId, parseTarId } from "../src/tar-id";
import { explorerAddressUrl, explorerTxUrl } from "../src/chains";

describe("TAR id", () => {
  it("parses the form DCAP.Web returns (no 0x)", () => {
    expect(parseTarId("urn:tar:eip155.128123:073d7a18417bc1feb1c88a342f7e26e6a62745ec")).toEqual({
      chainId: 128123,
      address: "0x073d7a18417bc1feb1c88a342f7e26e6a62745ec",
    });
  });

  it("accepts a 0x address, mixed case, and a version suffix", () => {
    expect(parseTarId("urn:tar:eip155.31337:0x5FbDB2315678afecb367f032d93F642f64180aa3:2")).toEqual({
      chainId: 31337,
      address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      version: 2,
    });
  });

  it("rejects junk", () => {
    for (const bad of ["", "urn:tar:eip155.1:xyz", "urn:tar:eip155:5fbdb2315678afecb367f032d93f642f64180aa3", "0x5fbd"]) {
      expect(isTarId(bad)).toBe(false);
      expect(() => parseTarId(bad)).toThrow();
    }
  });

  it("formats and round-trips", () => {
    const id = formatTarId(127823, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(id).toBe("urn:tar:eip155.127823:5fbdb2315678afecb367f032d93f642f64180aa3");
    expect(parseTarId(id).address).toBe("0x5fbdb2315678afecb367f032d93f642f64180aa3");
  });
});

describe("explorer links", () => {
  it("point at Etherlink Shadownet for chain 127823", () => {
    expect(explorerTxUrl(127823, "0xabc")).toBe("https://shadownet.explorer.etherlink.com/tx/0xabc");
    expect(explorerAddressUrl(127823, "0xdef")).toBe("https://shadownet.explorer.etherlink.com/address/0xdef");
  });

  it("are null for local Hardhat", () => {
    expect(explorerTxUrl(31337, "0xabc")).toBeNull();
  });
});
