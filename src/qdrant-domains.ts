/** Explicit search-domain registration. Tenant names are configuration, not code. */
export type QdrantDomain = string;
export type DomainRegistration = { alias: string; collections: string[]; prefixes?: string[] };
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function legacyDomainForCollection(collection: string): string | undefined {
  if (collection === "cellect_docs" || collection === "rooms-cellect" || collection.startsWith("rooms-cellect-")) return "cellect";
  if (["wip", "shape_docusign", "rooms-shape"].includes(collection)
    || ["project-", "email-", "gdrive_", "gdrive-", "rooms-shape-"].some(p => collection.startsWith(p))) return "shape";
  if (["jersey_city_", "nj_", "hudson_county_", "hoboken_", "weehawken_", "west_new_york_"].some(p => collection.startsWith(p))) return "public";
  return undefined;
}

export function registeredQdrantDomains(env: NodeJS.ProcessEnv = process.env): Record<string, DomainRegistration> {
  const raw = env.QMD_QDRANT_DOMAIN_REGISTRY;
  if (!raw) return {};
  const entries: unknown = JSON.parse(raw);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid Qdrant domain registry");
  const result: Record<string, DomainRegistration> = Object.create(null);
  const aliases = new Set([
    env.QMD_QDRANT_PUBLIC_COLLECTION || "cellect_public_current",
    env.QMD_QDRANT_SHAPE_COLLECTION || "tenant_shape_current",
    env.QMD_QDRANT_CELLECT_COLLECTION,
  ].filter(Boolean));
  const selectors: Array<{ value: string; prefix: boolean }> = [];
  for (const [domain, value] of Object.entries(entries)) {
    if (!ID.test(domain) || ["public", "shape", "cellect", "all"].includes(domain)) throw new Error("Invalid or reserved Qdrant domain registration");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Qdrant registration: ${domain}`);
    const entry = value as DomainRegistration;
    if (Object.keys(entry).some(k => !["alias", "collections", "prefixes"].includes(k))
      || typeof entry.alias !== "string" || !NAME.test(entry.alias)
      || !Array.isArray(entry.collections) || !entry.collections.length
      || entry.collections.some(c => typeof c !== "string" || !NAME.test(c))
      || (entry.prefixes !== undefined && (!Array.isArray(entry.prefixes) || entry.prefixes.some(p => typeof p !== "string" || !NAME.test(p))))) {
      throw new Error(`Invalid Qdrant registration: ${domain}`);
    }
    if (aliases.has(entry.alias)) throw new Error("Qdrant domains must use distinct aliases");
    aliases.add(entry.alias);
    for (const selector of [...entry.collections.map(value => ({ value, prefix: false })), ...(entry.prefixes ?? []).map(value => ({ value, prefix: true }))]) {
      if (legacyDomainForCollection(selector.value)
        || (selector.prefix && ["rooms-shape", "rooms-cellect", "cellect_docs", "wip", "shape_docusign", "project-", "email-", "gdrive_", "gdrive-", "jersey_city_", "nj_", "hudson_county_", "hoboken_", "weehawken_", "west_new_york_"].some(p => p.startsWith(selector.value)))
        || selectors.some(p => p.value === selector.value || (p.prefix && selector.value.startsWith(p.value)) || (selector.prefix && p.value.startsWith(selector.value)))) {
        throw new Error("Qdrant collection mappings must not overlap security domains");
      }
      selectors.push(selector);
    }
    result[domain] = entry;
  }
  return result;
}

export function qdrantAliases(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    public: env.QMD_QDRANT_PUBLIC_COLLECTION || "cellect_public_current",
    shape: env.QMD_QDRANT_SHAPE_COLLECTION || "tenant_shape_current",
    cellect: env.QMD_QDRANT_CELLECT_COLLECTION?.trim() ?? "",
    ...Object.fromEntries(Object.entries(registeredQdrantDomains(env)).map(([id, entry]) => [id, entry.alias])),
  };
}

export function validateQdrantImportTenant(domain: string, tenant: string | undefined): void {
  if (tenant !== undefined && domain !== "public" && tenant !== domain) {
    throw new Error("Qdrant import tenant does not match collection domain");
  }
  if (!["public", "shape", "cellect"].includes(domain) && tenant === undefined) {
    throw new Error("Registered private Qdrant domains require a tenant ACL manifest");
  }
}

export function qdrantDomainForCollection(collection: string): QdrantDomain {
  for (const [domain, entry] of Object.entries(registeredQdrantDomains())) {
    if (entry.collections.includes(collection) || entry.prefixes?.some(p => collection.startsWith(p))) return domain;
  }
  const legacy = legacyDomainForCollection(collection);
  if (legacy) return legacy;
  throw new Error(`Qdrant security domain is not classified for collection: ${collection}`);
}
