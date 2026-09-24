import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScopedSearchConfig, ScopedAuthError, verifyScopedSearchToken } from "../src/scoped-auth.js";

const secret = Buffer.from("scoped-test-secret-with-at-least-thirty-two-bytes");
const config = { secret, collections: ["rooms-shape-24-bright"] };
const now = 1_788_000_000;

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", ...header })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    sub: "user@example.com",
    iss: "cellect-rooms",
    aud: "cellect-qmd-private",
    iat: now,
    exp: now + 90,
    tenant: "shape",
    scopes: ["project:24-bright-street"],
    access: ["documents"],
    mode: "user",
    ...overrides,
  })).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

describe("scoped QMD token verification", () => {
  test("accepts the rooms issuer, private audience, and explicit ACL", () => {
    expect(verifyScopedSearchToken(token(), config, now + 1)).toMatchObject({
      tenant: "shape",
      scopes: ["project:24-bright-street"],
      access: ["documents"],
    });
  });

  test.each([
    ["wrong audience", { aud: "cellect-qmd-public" }, {}],
    ["expired", { exp: now }, {}],
    ["overlong", { exp: now + 121 }, {}],
    ["wildcard", { scopes: ["project:*"] }, {}],
    ["wrong algorithm", {}, { alg: "none" }],
  ])("rejects %s tokens", (_name, overrides, header) => {
    expect(() => verifyScopedSearchToken(token(overrides, header), config, now + 1)).toThrow(ScopedAuthError);
  });

  test.each([
    ["header", "null"], ["payload", "null"], ["header", "[]"], ["payload", "42"],
  ])("rejects a correctly signed %s that decodes to %s as a scoped-auth error", (part, json) => {
    const parts = token().split(".");
    parts[part === "header" ? 0 : 1] = Buffer.from(json).toString("base64url");
    parts[2] = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    expect(() => verifyScopedSearchToken(parts.join("."), config, now + 1)).toThrow(ScopedAuthError);
  });

  test("rejects a modified signature", () => {
    const value = token();
    const parts = value.split(".");
    parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
    expect(() => verifyScopedSearchToken(parts.join("."), config, now + 1)).toThrow("signature");
  });

  describe("QMD_SCOPED_TENANT pin", () => {
    const pinned = { ...config, tenant: "shape" };

    test("accepts its own tenant, with or without a matching kid", () => {
      expect(verifyScopedSearchToken(token(), pinned, now + 1).tenant).toBe("shape");
      expect(verifyScopedSearchToken(token({}, { kid: "shape" }), pinned, now + 1).tenant).toBe("shape");
    });

    test("rejects another tenant's claim even when signed with this sidecar's secret", () => {
      expect(() => verifyScopedSearchToken(token({ tenant: "cellect" }), pinned, now + 1)).toThrow("another tenant");
      // Without a pin the same token verifies: the pin is what closes the gap.
      expect(verifyScopedSearchToken(token({ tenant: "cellect" }), config, now + 1).tenant).toBe("cellect");
    });

    test("rejects a kid for another tenant", () => {
      expect(() => verifyScopedSearchToken(token({}, { kid: "cellect" }), pinned, now + 1)).toThrow("another tenant");
    });

    test("is loaded from the environment and validated", () => {
      const dir = mkdtempSync(join(tmpdir(), "qmd-scoped-pin-"));
      try {
        const secretFile = join(dir, "secret");
        writeFileSync(secretFile, secret.toString("utf8"));
        const env = { QMD_SCOPED_TOKEN_SECRET_FILE: secretFile, QMD_SCOPED_COLLECTIONS: "rooms-cellect" };
        expect(loadScopedSearchConfig(env)?.tenant).toBeUndefined();
        expect(loadScopedSearchConfig({ ...env, QMD_SCOPED_TENANT: "cellect" })?.tenant).toBe("cellect");
        expect(() => loadScopedSearchConfig({ ...env, QMD_SCOPED_TENANT: "Cellect!" })).toThrow("QMD_SCOPED_TENANT");
        expect(() => loadScopedSearchConfig({ QMD_SCOPED_TENANT: "cellect" })).toThrow("configured together");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
