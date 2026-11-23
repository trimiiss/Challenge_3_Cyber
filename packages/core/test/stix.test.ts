import { describe, expect, it } from "vitest";
import { alertToStixIncident, jcsSha256, uuidV5 } from "../src/index";

describe("uuidV5 (RFC 4122 §4.3)", () => {
  it("matches the well-known DNS-namespace vector", () => {
    // uuid.uuid5(uuid.NAMESPACE_DNS, "python.org") in CPython
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });
  it("is deterministic and sets version 5 / RFC 4122 variant", () => {
    const a = uuidV5("uibm-grades-prod/alert/1");
    expect(a).toBe(uuidV5("uibm-grades-prod/alert/1"));
    expect(a).not.toBe(uuidV5("uibm-grades-prod/alert/2"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("alertToStixIncident", () => {
  const alert = {
    id: 7,
    kind: "deleted_auth_entry",
    severity: "critical" as const,
    title: "Auth audit entry bb32d229 (auth.login auth.users:auditor@vula.test) was DELETED",
    details: { layer: "source-vs-log", version: 3, index: 41, fingerprint: "abc", reporter: "cli", email: "auditor@vula.test" },
    created_at: "2026-11-23T14:30:00.123456Z",
  };
  const ctx = { logId: "uibm-grades-prod", logTarId: "urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3" };

  it("builds a valid STIX 2.1 incident with a deterministic id", () => {
    const o = alertToStixIncident(alert, ctx);
    expect(o.type).toBe("incident");
    expect(o.spec_version).toBe("2.1");
    expect(o.id).toBe(`incident--${uuidV5("uibm-grades-prod/alert/7")}`);
    expect(o.created).toBe("2026-11-23T14:30:00.123Z");
    expect(o.modified).toBe(o.created);
    expect(o.labels).toEqual(["audit-log-tampering", "deleted_auth_entry", "critical"]);
    expect(o.x_vula_checkpoint_version).toBe(3);
    expect(o.x_vula_leaf_index).toBe(41);
    expect(o.external_references?.[0]?.external_id).toBe(ctx.logTarId);
    // every custom property is x_-prefixed (STIX 2.1 §11.1)
    const std = new Set(["type", "spec_version", "id", "created", "modified", "name", "description", "labels", "external_references"]);
    for (const k of Object.keys(o)) if (!std.has(k)) expect(k.startsWith("x_")).toBe(true);
  });

  it("shares no row data, only a commitment to the full alert", () => {
    const o = alertToStixIncident(alert, ctx);
    const text = JSON.stringify(o);
    expect(text).not.toContain("auditor@vula.test");
    expect(text).not.toContain("bb32d229");
    expect(o.x_vula_alert_sha256).toBe(jcsSha256({ ...alert, created_at: "2026-11-23T14:30:00.123Z" }));
  });

  it("maps log-server kinds without a layer", () => {
    const o = alertToStixIncident({ ...alert, kind: "heartbeat_gap", details: {} }, { ...ctx, logTarId: null });
    expect(o.x_vula_layer).toBe("liveness");
    expect(o.description).toContain("went silent");
    expect(o.external_references).toBeUndefined();
  });
});
