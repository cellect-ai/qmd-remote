import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export type QueryApiIdentity = {
  id: string;
  tokenHash: Buffer;
  collections: Set<string>;
};

export type QueryApiAuthConfig = {
  identities: QueryApiIdentity[];
};

export class QueryApiAuthError extends Error {
  readonly status: 401 | 403;

  constructor(message = "Unauthorized", status: 401 | 403 = 401) {
    super(message);
    this.status = status;
  }
}

function nonEmptyStrings(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const values = [...new Set(value)];
  if (values.length !== value.length || values.some(item => typeof item !== "string" || item.length < 1 || item.length > 200)) {
    throw new Error(`${name} contains an invalid value`);
  }
  return values as string[];
}

/**
 * Loads the policy for the externally reachable structured-query endpoint.
 *
 * The policy stores SHA-256 token digests, never bearer tokens. Raw role
 * tokens stay in the caller's secret projection, while QMD can still reject a
 * caller before it chooses a collection. Leaving the setting unset preserves
 * legacy local-only behavior; production must set it before publishing /query.
 */
export function loadQueryApiAuthConfig(env: NodeJS.ProcessEnv = process.env): QueryApiAuthConfig | null {
  const path = env.QMD_QUERY_AUTH_FILE?.trim();
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("QMD query authorization policy cannot be read");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("QMD query authorization policy is invalid");
  const document = parsed as { version?: unknown; identities?: unknown };
  if (document.version !== 1 || !Array.isArray(document.identities) || document.identities.length < 1 || document.identities.length > 200) {
    throw new Error("QMD query authorization policy is invalid");
  }

  const ids = new Set<string>();
  const tokenHashes = new Set<string>();
  const identities = document.identities.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error("QMD query authorization identity is invalid");
    const item = value as { id?: unknown; token_sha256?: unknown; collections?: unknown };
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.id) || ids.has(item.id)) {
      throw new Error("QMD query authorization identity id is invalid");
    }
    if (typeof item.token_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.token_sha256) || tokenHashes.has(item.token_sha256)) {
      throw new Error("QMD query authorization token digest is invalid");
    }
    const collections = nonEmptyStrings(item.collections, `QMD query authorization identity ${index} collections`, 100);
    ids.add(item.id);
    tokenHashes.add(item.token_sha256);
    return { id: item.id, tokenHash: Buffer.from(item.token_sha256, "hex"), collections: new Set(collections) };
  });
  return { identities };
}

export function queryApiBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([^\s]{1,4096})$/);
  if (!match) throw new QueryApiAuthError();
  return match[1]!;
}

export function verifyQueryApiToken(token: string, config: QueryApiAuthConfig): QueryApiIdentity {
  const digest = createHash("sha256").update(token, "utf8").digest();
  for (const identity of config.identities) {
    if (timingSafeEqual(digest, identity.tokenHash)) return identity;
  }
  throw new QueryApiAuthError();
}

export function authorizeQueryCollections(identity: QueryApiIdentity, collections: string[]): string[] {
  if (collections.some(collection => !identity.collections.has(collection))) {
    throw new QueryApiAuthError("Forbidden collection", 403);
  }
  return collections;
}
