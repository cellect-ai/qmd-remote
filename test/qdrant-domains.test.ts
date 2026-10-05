import { afterEach, describe, expect, test, vi } from "vitest";
import { qdrantAliases, qdrantDomainForCollection, registeredQdrantDomains, validateQdrantImportTenant } from "../src/qdrant-domains.js";

const registry = {
  terra: { alias: "rooms_terra_current", collections: ["rooms-terra"], prefixes: ["rooms-terra-"] },
  yellowstone: { alias: "rooms_yellowstone_current", collections: ["rooms-yellowstone"], prefixes: ["rooms-yellowstone-"] },
};
afterEach(() => vi.unstubAllEnvs());

describe("configured Qdrant tenant domains", () => {
  test("requires correctly bound ACLs before importing new private domains", () => {
    expect(() => validateQdrantImportTenant("terra", undefined)).toThrow("require a tenant ACL");
    expect(() => validateQdrantImportTenant("terra", "yellowstone")).toThrow("does not match");
    expect(() => validateQdrantImportTenant("yellowstone", "terra")).toThrow("does not match");
    expect(() => validateQdrantImportTenant("terra", "terra")).not.toThrow();
    expect(() => validateQdrantImportTenant("yellowstone", "yellowstone")).not.toThrow();
  });
  test("registers Terra and Yellowstone without adding names to application code", () => {
    vi.stubEnv("QMD_QDRANT_DOMAIN_REGISTRY", JSON.stringify(registry));
    expect(qdrantDomainForCollection("rooms-terra")).toBe("terra");
    expect(qdrantDomainForCollection("rooms-terra-project-1")).toBe("terra");
    expect(qdrantDomainForCollection("rooms-yellowstone")).toBe("yellowstone");
    expect(qdrantAliases()).toMatchObject({ terra: "rooms_terra_current", yellowstone: "rooms_yellowstone_current" });
    expect(qdrantDomainForCollection("rooms-shape")).toBe("shape");
    expect(qdrantDomainForCollection("rooms-cellect")).toBe("cellect");
    expect(() => qdrantDomainForCollection("rooms-terrax")).toThrow("not classified");
    expect(() => qdrantDomainForCollection("rooms-norfin")).toThrow("not classified");
  });

  test("does not send unregistered tenant collections to Shape", () => {
    vi.stubEnv("QMD_QDRANT_DOMAIN_REGISTRY", "");
    for (const name of ["rooms-terra", "rooms-yellowstone", "rooms-other"]) {
      expect(() => qdrantDomainForCollection(name)).toThrow("not classified");
    }
  });

  test("rejects shared aliases and overlapping collection ownership", () => {
    expect(() => registeredQdrantDomains({ QMD_QDRANT_DOMAIN_REGISTRY: JSON.stringify({ ...registry,
      yellowstone: { ...registry.yellowstone, alias: registry.terra.alias } }) })).toThrow("distinct aliases");
    expect(() => registeredQdrantDomains({ QMD_QDRANT_DOMAIN_REGISTRY: JSON.stringify({ ...registry,
      yellowstone: { ...registry.yellowstone, collections: ["rooms-terra-secret"] } }) })).toThrow("must not overlap");
    expect(() => registeredQdrantDomains({ QMD_QDRANT_DOMAIN_REGISTRY: JSON.stringify({
      terra: { ...registry.terra, collections: ["rooms-shape"] } }) })).toThrow("must not overlap");
    expect(() => registeredQdrantDomains({ QMD_QDRANT_DOMAIN_REGISTRY: JSON.stringify({
      terra: { ...registry.terra, prefixes: ["rooms-"] } }) })).toThrow("must not overlap");
  });

  test("rejects malformed registries and reserved domains", () => {
    for (const bad of ["[]", "null", '{"shape":{"alias":"other","collections":["rooms-other"]}}',
      '{"terra":{"alias":"","collections":[]}}', '{"terra":{"alias":"ok","collections":["rooms-terra"],"extra":true}}']) {
      expect(() => registeredQdrantDomains({ QMD_QDRANT_DOMAIN_REGISTRY: bad })).toThrow();
    }
  });
});
