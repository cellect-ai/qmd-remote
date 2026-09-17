import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
let dir: string;
let server: HttpServerHandle;
let base: string;
const secret = "private-http-test-secret-at-least-thirty-two-bytes";
const token = () => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "cellect-rooms", aud: "cellect-qmd-private", sub: "test", tenant: "shape",
    scopes: ["project:bright"], access: ["documents"], mode: "user", iat: now, exp: now + 90 })).toString("base64url");
  return `${header}.${body}.${createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")}`;
};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-private-http-"));
  await writeFile(join(dir, "secret"), secret);
  vi.stubEnv("QMD_SCOPED_TOKEN_SECRET_FILE", join(dir, "secret"));
  vi.stubEnv("QMD_SCOPED_COLLECTIONS", "rooms-shape");
  vi.stubEnv("QMD_QDRANT_URL", "https://qdrant.test");
  vi.stubEnv("QMD_CONFIG_DIR", dir);
  vi.stubEnv("QMD_HTTP_MAX_BODY_BYTES", "1024");
  server = await startMcpHttpServer(0, { dbPath: join(dir, "index.sqlite"), host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server?.stop(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const post = (body: unknown, auth = true) => fetch(`${base}/scoped-query`, { method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token()}` } : {}) }, body: JSON.stringify(body) });
test("health is reachable and missing authentication fails closed", async () => {
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await post({ searches: [{ type: "lex", query: "agreement" }] }, false)).status).toBe(401);
});
test.each(["/query", "/search", "/mcp", "/get", "/collections"])("private index has no generic route %s", async path => {
  expect((await fetch(`${base}${path}`, { method: "POST", body: "{}" })).status).toBe(404);
});
test("valid typed narrowing filter reaches search and returns an empty eligible set", async () => {
  const res = await post({ searches: [{ type: "lex", query: "agreement" }], rerank: false,
    filter: { key: "status", operator: "eq", value: "approved" } });
  expect(res.status).toBe(200); expect(await res.json()).toEqual({ results: [] });
});
test("invalid filters and caller-controlled ACL dimensions are rejected", async () => {
  expect((await post({ searches: [{ type: "lex", query: "agreement" }], filter: { operator: "or", operands: [] } })).status).toBe(400);
  expect((await post({ searches: [{ type: "lex", query: "agreement" }], qdrantScope: { tenant: "other" } })).status).toBe(400);
});
test("oversized bodies are rejected", async () => {
  expect((await post({ query: "x".repeat(2000) })).status).toBe(400);
});
