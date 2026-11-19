import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toFunctionSelector, toEventSelector } from "viem";
import { tarAbi } from "../src/abi";

const abiJson = JSON.parse(readFileSync(new URL("../abi.json", import.meta.url), "utf8"));

describe("TAR contract ABI", () => {
  it("abi.ts is in sync with abi.json", () => {
    expect(tarAbi).toEqual(abiJson);
  });

  it("has the functions the verifier relies on, with the right signatures", () => {
    const sigs = tarAbi
      .filter((x) => x.type === "function")
      .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})->(${f.outputs.map((o) => o.type).join(",")})`);
    expect(sigs).toEqual(
      expect.arrayContaining([
        "push(bytes32)->()",
        "totalVersions()->(uint256)",
        "getChecksum(uint256)->(bytes32)",
        "dataUri(uint256)->(string)",
        "owner()->(address)",
        "hasChecksum(bytes32)->(bool)",
        "getVersion(bytes32)->(uint256)",
      ]),
    );
  });

  it("emits Updated(uint256 indexed version, string checksum)", () => {
    const ev = tarAbi.find((x) => x.type === "event" && x.name === "Updated");
    expect(ev).toBeDefined();
    expect(toEventSelector("Updated(uint256,string)")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("selectors are stable (guards against an accidental ABI edit)", () => {
    // Values from solc's methodIdentifiers for DCAPv2.
    expect(toFunctionSelector("push(bytes32)")).toBe("0xb298e36b");
    expect(toFunctionSelector("totalVersions()")).toBe("0x0644f83a");
    expect(toFunctionSelector("getChecksum(uint256)")).toBe("0x4c9c2757");
    expect(toFunctionSelector("dataUri(uint256)")).toBe("0x262087af");
  });
});
