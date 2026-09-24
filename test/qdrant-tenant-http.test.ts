/**
 * qdrant-tenant-http.test.ts - End-to-end authorization for the two ways QMD is
 * published: a tenant-pinned scoped sidecar (Rooms) and the identity-authenticated
 * central endpoint (query-auth). Qdrant is a fetch stub that records filters.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

const realFetch = globalThis.fetch;
const secret = "tenant-http-test-secret-at-least-thirty-two-bytes";
let dir: string;
let qdrantCalls: { url: string; body: any }[] = [];

// Plain env and fetch stubs, so the file also runs under `bun test`.
const savedEnv = new Map<string, string | undefined>();
function stubEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}
function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

function stubQdrant(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://qdrant.test")) return realFetch(input, init);
    qdrantCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ result: { groups: [] } });
  }) as typeof fetch;
}

function scopedToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", ...header })).toString("base64url");
  const b = Buffer.from(JSON.stringify({
    iss: "cellect-rooms", aud: "cellect-qmd-private", sub: "test", tenant: "cellect",
    scopes: ["company:cellect"], access: ["documents"], mode: "user", iat: now, exp: now + 90, ...claims,
  })).toString("base64url");
  return `${h}.${b}.${createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url")}`;
}

function filterKeys(call: { body: any }): Record<string, unknown>[] {
  return (call.body.prefetch ?? [call.body]).flatMap((stage: any) => stage.filter?.must ?? []);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-tenant-http-"));
  await writeFile(join(dir, "secret"), secret);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  qdrantCalls = [];
});

function baseEnv(): void {
  stubEnv("QMD_CONFIG_DIR", dir);
  stubEnv("QMD_QDRANT_URL", "https://qdrant.test");
  stubEnv("QMD_QDRANT_API_KEY", "test");
}

describe("startup guards", () => {
  afterEach(restoreEnv);

  test("refuses to start as both a scoped sidecar and an identity endpoint", async () => {
    baseEnv();
    stubEnv("QMD_QDRANT_ALLOWED_DOMAINS", "shape");
    stubEnv("QMD_SCOPED_TOKEN_SECRET_FILE", join(dir, "secret"));
    stubEnv("QMD_SCOPED_COLLECTIONS", "rooms-shape");
    stubEnv("QMD_QUERY_AUTH_FILE", join(dir, "missing-is-not-reached.json"));
    await writeFile(join(dir, "missing-is-not-reached.json"), JSON.stringify({
      version: 1, identities: [{ id: "a", token_sha256: "0".repeat(64), collections: ["wip"] }],
    }));
    await expect(startMcpHttpServer(0, { dbPath: join(dir, "both.sqlite"), host: "127.0.0.1", quiet: true }))
      .rejects.toThrow("cannot both be configured");
  });

  test("refuses to start when the cellect domain has no alias", async () => {
    baseEnv();
    stubEnv("QMD_QDRANT_ALLOWED_DOMAINS", "cellect");
    stubEnv("QMD_QDRANT_CELLECT_COLLECTION", "");
    await expect(startMcpHttpServer(0, { dbPath: join(dir, "alias.sqlite"), host: "127.0.0.1", quiet: true }))
      .rejects.toThrow("QMD_QDRANT_CELLECT_COLLECTION is required");
  });
});

describe("tenant-pinned scoped sidecar", () => {
  let server: HttpServerHandle;
  let base: string;

  beforeAll(async () => {
    baseEnv();
    stubEnv("QMD_QDRANT_ALLOWED_DOMAINS", "cellect");
    stubEnv("QMD_QDRANT_CELLECT_COLLECTION", "rooms_cellect_current");
    stubEnv("QMD_SCOPED_TOKEN_SECRET_FILE", join(dir, "secret"));
    stubEnv("QMD_SCOPED_COLLECTIONS", "rooms-cellect");
    stubEnv("QMD_SCOPED_TENANT", "cellect");
    server = await startMcpHttpServer(0, { dbPath: join(dir, "sidecar.sqlite"), host: "127.0.0.1", quiet: true });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop();
    restoreEnv();
  });

  const post = (body: unknown, token?: string) => {
    stubQdrant();
    return fetch(`${base}/scoped-query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  const lex = { searches: [{ type: "lex", query: "agreement" }], rerank: false };

  test("its own tenant searches only its collection with the token's ACL", async () => {
    const res = await post(lex, scopedToken({}, { kid: "cellect" }));
    expect(res.status).toBe(200);
    expect(qdrantCalls.length).toBeGreaterThan(0);
    for (const call of qdrantCalls) {
      expect(call.url).toContain("/collections/rooms_cellect_current/");
      expect(filterKeys(call)).toEqual(expect.arrayContaining([
        { key: "source_collection", match: { any: ["rooms-cellect"] } },
        { key: "tenant_id", match: { value: "cellect" } },
        { key: "scope_keys", match: { any: ["company:cellect"] } },
        { key: "access_classes", match: { any: ["documents"] } },
      ]));
    }
  });

  test("another tenant's token signed with this secret is rejected", async () => {
    expect((await post(lex, scopedToken({ tenant: "shape" }))).status).toBe(401);
    expect((await post(lex, scopedToken({}, { kid: "shape" }))).status).toBe(401);
    expect(qdrantCalls).toHaveLength(0);
  });

  test("a token whose header or payload is JSON null is 401, not 500", async () => {
    const [h, b] = scopedToken().split(".");
    const nul = Buffer.from("null").toString("base64url");
    const signed = (head: string, body: string) =>
      `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
    expect((await post(lex, signed(nul, b!))).status).toBe(401);
    expect((await post(lex, signed(h!, nul))).status).toBe(401);
    expect(qdrantCalls).toHaveLength(0);
  });

  test("client-supplied collections and ACL dimensions are rejected before search", async () => {
    const token = scopedToken();
    expect((await post({ ...lex, collections: ["rooms-shape"] }, token)).status).toBe(400);
    expect((await post({ ...lex, collection: "rooms-shape" }, token)).status).toBe(400);
    expect((await post({ ...lex, qdrantScope: { tenant: "shape", scopes: ["project:x"], access: ["money"] } }, token)).status).toBe(400);
    expect(qdrantCalls).toHaveLength(0);
  });

  test("generic routes stay closed", async () => {
    for (const path of ["/query", "/search", "/mcp"]) {
      expect((await realFetch(`${base}${path}`, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });
});

describe("identity-authenticated central endpoint", () => {
  const token = "central-query-token-for-tests";
  let server: HttpServerHandle;
  let base: string;

  beforeAll(async () => {
    const policy = join(dir, "query-auth.json");
    await writeFile(policy, JSON.stringify({ version: 1, identities: [{
      id: "cellect-superadmin-cellect",
      token_sha256: createHash("sha256").update(token).digest("hex"),
      collections: ["cellect_docs"],
    }] }));
    baseEnv();
    stubEnv("QMD_QDRANT_ALLOWED_DOMAINS", "public,shape,cellect");
    stubEnv("QMD_QDRANT_CELLECT_COLLECTION", "tenant_cellect_current");
    stubEnv("QMD_QUERY_AUTH_FILE", policy);
    server = await startMcpHttpServer(0, { dbPath: join(dir, "central.sqlite"), host: "127.0.0.1", quiet: true });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop();
    restoreEnv();
  });

  const query = (body: unknown, bearer?: string) => {
    stubQdrant();
    return fetch(`${base}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  const lex = { searches: [{ type: "lex", query: "policy" }], rerank: false };

  test("an identity reaches its own collection through its domain alias", async () => {
    const res = await query({ ...lex, collections: ["cellect_docs"] }, token);
    expect(res.status).toBe(200);
    expect(qdrantCalls.length).toBeGreaterThan(0);
    for (const call of qdrantCalls) expect(call.url).toContain("/collections/tenant_cellect_current/");
  });

  test("other collections are forbidden and bad credentials unauthorized", async () => {
    expect((await query({ ...lex, collections: ["wip"] }, token)).status).toBe(403);
    expect((await query({ ...lex, collections: ["cellect_docs", "wip"] }, token)).status).toBe(403);
    expect((await query({ ...lex, collections: ["cellect_docs"] })).status).toBe(401);
    expect((await query({ ...lex, collections: ["cellect_docs"] }, "wrong-token")).status).toBe(401);
    expect(qdrantCalls).toHaveLength(0);
  });

  test("collections are mandatory, parameters are bounded, and /mcp is closed", async () => {
    expect((await query(lex, token)).status).toBe(400);
    expect((await query({ searches: [{ type: "lex", query: "x".repeat(5000) }], collections: ["cellect_docs"] }, token)).status).toBe(400);
    expect((await query({ ...lex, collections: ["cellect_docs"], limit: 1000 }, token)).status).toBe(400);
    expect((await realFetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
