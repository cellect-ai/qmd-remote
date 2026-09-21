import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  authorizeQueryCollections,
  loadQueryApiAuthConfig,
  QueryApiAuthError,
  queryApiBearerToken,
  verifyQueryApiToken,
} from "../src/query-auth.js";

const token = "test-query-api-token";
const digest = createHash("sha256").update(token).digest("hex");

function policy(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "qmd-query-auth-"));
  const path = join(directory, "policy.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("QMD structured-query authorization", () => {
  test("accepts a token only for its configured collections", () => {
    const path = policy({
      version: 1,
      identities: [{ id: "shape-admin", token_sha256: digest, collections: ["wip", "jersey_city_code"] }],
    });
    try {
      const config = loadQueryApiAuthConfig({ QMD_QUERY_AUTH_FILE: path })!;
      const identity = verifyQueryApiToken(queryApiBearerToken(`Bearer ${token}`), config);
      expect(identity.id).toBe("shape-admin");
      expect(authorizeQueryCollections(identity, ["wip"])).toEqual(["wip"]);
      expect(() => authorizeQueryCollections(identity, ["tenant-cellect-docs"])).toThrow(QueryApiAuthError);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("rejects missing or invalid credentials and malformed policies", () => {
    const path = policy({
      version: 1,
      identities: [{ id: "shape-admin", token_sha256: digest, collections: ["wip"] }],
    });
    try {
      const config = loadQueryApiAuthConfig({ QMD_QUERY_AUTH_FILE: path })!;
      expect(() => queryApiBearerToken(undefined)).toThrow(QueryApiAuthError);
      expect(() => verifyQueryApiToken("wrong", config)).toThrow(QueryApiAuthError);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
    const malformed = policy({ version: 1, identities: [{ id: "shape-admin", token_sha256: "not-a-digest", collections: ["wip"] }] });
    try {
      expect(() => loadQueryApiAuthConfig({ QMD_QUERY_AUTH_FILE: malformed })).toThrow("digest");
    } finally {
      rmSync(malformed, { force: true });
      rmSync(join(malformed, ".."), { recursive: true, force: true });
    }
  });
});
