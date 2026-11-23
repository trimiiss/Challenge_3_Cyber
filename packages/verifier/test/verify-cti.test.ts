import { describe, expect, it } from "vitest";
import { alertToStixIncident, jcs, jcsSha256, sha256Hex } from "@vula/core";
import { verifyCtiTar, type CtiSources } from "../src/index";

const TAR = "urn:tar:eip155.31337:8464135c8f25da09e49bc8782676a84730c318bc";
const URL = "http://localhost:8091/objects/4Vztc_N09fwojMCfDqBpGQ7UtfkIGc5pjseX_ZXmhw4.json";

const incident = alertToStixIncident(
  { id: 3, kind: "deleted_auth_entry", severity: "critical", title: "t", details: { layer: "source-vs-log" }, created_at: "2026-11-23T14:30:00Z" },
  { logId: "uibm-grades-prod", logTarId: null },
) as unknown as Record<string, unknown>;
/** BCBCTI stores the object in JCS form and hashes those bytes. */
const objectText = jcs(incident);
const b64 = (hexStr: string) => Buffer.from(hexStr, "hex").toString("base64");

/**
 * The TAR payload text exactly as BCBCTI v1.0.0-rc.3 sends it to DCAP.Web (seen live): not JCS (key order,
 * `+`), type `stixBundle`, base64 artifact hash. DCAP.Web anchors SHA-256 of this exact text.
 */
function bcbctiPayloadText(objectHash: string): string {
  return (
    `{"@context":"urn:tar:...","@type":"stixBundle","version":"2.1","bundle":{"objects":[{"url":"${URL}",` +
    `"hashes":{"SHA-256":"${objectHash}"},"mime_type":"application/stix\\u002Bjson;version=2.1","type":"artifact",` +
    `"id":"artifact--00460bfb-b622-5ed3-af38-ccafeb568812"}],"type":"bundle","id":"bundle--87238659-6696-48f9-963b-e4db02091654"}}`
  );
}

function world(over: { payload?: string; object?: string | null; checksums?: string[] } = {}): CtiSources {
  const payload = over.payload ?? bcbctiPayloadText(b64(sha256Hex(objectText)));
  const checksums = over.checksums ?? [`0x${sha256Hex(payload).toUpperCase()}`];
  const object = "object" in over ? over.object : objectText;
  return {
    chain: { tarId: TAR, chainId: 31337, totalVersions: async () => checksums.length, getChecksum: async (v) => checksums[v]! },
    fetchTarPayload: async () => payload,
    fetchObject: async (u) => (u === URL ? (object ?? null) : null),
  };
}

describe("verifyCtiTar (BCBCTI verification flow)", () => {
  it("verifies an untouched incident in BCBCTI's real format (raw-body checksum, base64 hash, stixBundle)", async () => {
    const r = await verifyCtiTar(world());
    expect(r).toMatchObject({ ok: true, step: "verified", version: 0, artifactUrl: URL });
    expect(r.object?.id).toBe(incident.id);
  });

  it("also accepts the documented format (JCS checksum, hex hash, StixBundle)", async () => {
    const payload = {
      "@context": "urn:tar:...",
      "@type": "StixBundle",
      version: "2.1",
      bundle: { type: "bundle", id: "bundle--x", objects: [{ type: "artifact", id: "artifact--y", url: URL, hashes: { "SHA-256": jcsSha256(incident) } }] },
    };
    const r = await verifyCtiTar(world({ payload: JSON.stringify(payload, null, 2), checksums: [`0x${jcsSha256(payload)}`] }));
    expect(r).toMatchObject({ ok: true, step: "verified" });
  });

  it("uses the latest TAR version", async () => {
    const payload = bcbctiPayloadText(b64(sha256Hex(objectText)));
    const r = await verifyCtiTar(world({ payload, checksums: ["0xdead", `0x${sha256Hex(payload)}`] }));
    expect(r).toMatchObject({ ok: true, version: 1 });
  });

  it("fails at the TAR step when the payload host serves a different payload", async () => {
    const real = bcbctiPayloadText(b64(sha256Hex(objectText)));
    const forged = bcbctiPayloadText(b64("00".repeat(32)));
    const r = await verifyCtiTar(world({ payload: forged, checksums: [`0x${sha256Hex(real)}`] }));
    expect(r).toMatchObject({ ok: false, step: "tar" });
  });

  it("fails at the artifact step when the stored incident was edited (e.g. to downplay it)", async () => {
    const r = await verifyCtiTar(world({ object: jcs({ ...incident, x_vula_severity: "info" }) }));
    expect(r).toMatchObject({ ok: false, step: "artifact" });
    expect(r.reason).toContain("altered");
  });

  it("fails at the artifact step when the stored incident was deleted", async () => {
    const r = await verifyCtiTar(world({ object: null }));
    expect(r).toMatchObject({ ok: false, step: "artifact" });
  });

  it("rejects TARs that are not BCBCTI StixBundles", async () => {
    const payload = JSON.stringify({ "@context": "urn:tar:vula:checkpoint:v1", "@type": "VulaCheckpoint" });
    const r = await verifyCtiTar(world({ payload }));
    expect(r).toMatchObject({ ok: false, step: "type" });
  });

  it("fails on a TAR with no versions", async () => {
    const r = await verifyCtiTar(world({ checksums: [] }));
    expect(r).toMatchObject({ ok: false, step: "tar", version: null });
  });
});
