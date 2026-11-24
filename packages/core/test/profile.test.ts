import { describe, expect, it } from "vitest";
import {
  ASSET_SCHEMA_ROOT,
  CHECKPOINT_PROFILE_ID,
  checkpointProfile,
  checkpointSchema,
  jcs,
  matchCheckpointProfile,
  tarIdChainId,
} from "../src/index";

const ROOT = "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3";

describe("TAR profile (Compellio model: record @context -> profile TAR -> root asset schema TAR)", () => {
  it("profile document points to the root schema TAR first, like DCAP.Web's DCAP profile", () => {
    const p = checkpointProfile(ROOT);
    expect(p["@context"][0]).toBe(ROOT);
    expect(p["@id"]).toBe(CHECKPOINT_PROFILE_ID);
    expect(jcs(checkpointProfile(ROOT))).toBe(jcs(p)); // deterministic -> verifiable from the chain alone
  });

  it("defines a term for every checkpoint field", () => {
    const terms = (checkpointProfile(ROOT)["@context"][1] as Record<string, unknown>);
    const fields = Object.keys(checkpointSchema.shape).filter((k) => !k.startsWith("@"));
    for (const f of fields) expect(terms, f).toHaveProperty(f);
    expect(terms).toHaveProperty("VulaCheckpoint");
  });

  it("root asset schema is DCAP.Web's README document", () => {
    expect(ASSET_SCHEMA_ROOT["@id"]).toBe("https://gateway.satp.ietf.org/asset_schema/");
    expect(Object.keys(ASSET_SCHEMA_ROOT["@context"])).toEqual(
      ["@version", "foaf", "schema", "skos", "xsd", "rdf", "organization_key", "qualities"],
    );
  });

  it("matchCheckpointProfile accepts the exact document and returns its root", () => {
    expect(matchCheckpointProfile(JSON.parse(JSON.stringify(checkpointProfile(ROOT))))).toEqual({ ok: true, rootSchemaTarId: ROOT });
  });

  it("matchCheckpointProfile rejects anything else", () => {
    const p = checkpointProfile(ROOT);
    expect(matchCheckpointProfile({ ...p, "schema:version": "2" }).ok).toBe(false);
    expect(matchCheckpointProfile({ ...p, "@context": ["urn:other", p["@context"][1]] }).ok).toBe(false);
    expect(matchCheckpointProfile(ASSET_SCHEMA_ROOT).ok).toBe(false);
    expect(matchCheckpointProfile(null).ok).toBe(false);
  });

  it("tarIdChainId reads the EIP-155 chain id", () => {
    expect(tarIdChainId(ROOT)).toBe(31337);
    expect(tarIdChainId("urn:tar:eip155.127823:0x" + "a".repeat(40))).toBe(127823);
    expect(tarIdChainId("urn:vula:x")).toBeNull();
  });
});
