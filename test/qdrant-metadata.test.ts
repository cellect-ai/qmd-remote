import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStore, hashContent, insertContent, insertDocument, extractSnippet, type Store } from "../src/store.js";
import { replaceDocumentMetadata } from "../src/metadata-store.js";
import { METADATA_EXTRACTION_VERSION } from "../src/metadata.js";
import { searchQdrantWithMetadata } from "../src/qdrant-search.js";
import type { LLM } from "../src/llm.js";

let store: Store;
let points: any[];
let requests: any[];
const scope = { tenant: "shape", scopes: ["project:bright"], access: ["documents"] };
const llm = {
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [0.1, 0.2], model: "test" }))),
  rerank: vi.fn(async (_query: string, docs: any[]) => ({ results: docs.map(d => ({ file: d.file, score: 0.9 })) })),
} as unknown as LLM;
beforeEach(() => {
  store = createStore(":memory:"); points = []; requests = [];
  vi.stubEnv("QMD_QDRANT_URL", "https://qdrant.test");
  vi.stubEnv("QMD_QDRANT_API_KEY", "test");
  vi.stubEnv("QMD_QDRANT_ALLOWED_DOMAINS", "shape");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const stages = body.prefetch ?? [body];
    const ids = stages[0].filter.must.find((c: any) => c.key === "document_id")?.match.any;
    const eligible = points.filter(p => !ids || ids.includes(p.payload.document_id));
    return Response.json({ result: { groups: eligible.slice(0, body.limit).map(p => ({ hits: [p] })) } });
  }));
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function addDoc(index: number, status: string) {
  const body = `---\nqmd:\n  metadata:\n    status: ${status}\n---\n\n# Agreement\n\n${"Context\n".repeat(30)}Lucas Zorzal subscription agreement.\n`;
  const hash = await hashContent(body);
  insertContent(store.db, hash, body, "now");
  const id = insertDocument(store.db, "rooms-shape", `${index}.md`, "Agreement", hash, "now", "now");
  replaceDocumentMetadata(store.db, id, { metadata: { status, parties: ["Lucas Zorzal"] }, extractionVersion: METADATA_EXTRACTION_VERSION });
  points.push({ id, score: 0.9, payload: { document_id: String(id), external_document_id: `doc-${index}`, hash,
    source_collection: "rooms-shape", point_kind: "chunk", position: body.indexOf("Lucas"), chunk_length: 60 } });
}
const search = (filter?: any, rerank = false) => searchQdrantWithMetadata(store.db, {
  collections: ["rooms-shape"], searches: [{ type: "lex", query: "Zorzal" }, { type: "vec", query: "Zorzal subscription" }],
  limit: 10, candidateLimit: 40, minScore: 0, rerank, llm, scope, filter,
});
describe("Qdrant typed metadata with private ACL", () => {
  test("relative retrieval rank cannot rescue a model-rejected nonexistent name", async () => {
    await addDoc(1, "approved");
    vi.mocked(llm.rerank).mockResolvedValueOnce({ results: [{ file: "qmd://rooms-shape/1.md", score: 0.001, index: 0 }], model: "test" });
    expect(await search(undefined, true)).toEqual([]);
  });
  test("missing model evidence retains retrieval scores without manufacturing relevance", async () => {
    await addDoc(1, "approved");
    const baseline = await search();
    vi.mocked(llm.rerank).mockResolvedValueOnce({ results: [], model: "rerank-unavailable" });
    expect((await search(undefined, true)).map(r => r.score)).toEqual(baseline.map(r => r.score));
  });
  test("narrows before top-K and returns authoritative metadata and precise snippet offsets", async () => {
    for (let i = 0; i < 120; i++) await addDoc(i, i === 119 ? "approved" : "draft");
    const results = await search({ key: "status", operator: "eq", value: "approved" }, true);
    expect(results.map(r => r.externalDocumentId)).toEqual(["doc-119"]);
    expect(results[0]!.metadata).toEqual({ status: "approved", parties: ["Lucas Zorzal"] });
    expect(results[0]).not.toHaveProperty("internalDocumentId");
    for (const body of requests) for (const stage of body.prefetch ?? [body]) {
      expect(stage.filter.must).toEqual(expect.arrayContaining([
        { key: "document_id", match: { any: ["120"] } },
        { key: "tenant_id", match: { value: "shape" } },
        { key: "scope_keys", match: { any: scope.scopes } },
        { key: "access_classes", match: { any: scope.access } },
      ]));
    }
    expect(llm.embedBatch).toHaveBeenCalled(); expect(llm.rerank).toHaveBeenCalled();
    expect(vi.mocked(llm.rerank).mock.calls.at(-1)?.[1][0]?.text).toContain('"parties":["Lucas Zorzal"]');
    const result = results[0]!;
    const snippet = extractSnippet(result.body, "Zorzal", 300, result.bestChunkPos, result.bestChunk.length);
    expect(snippet.snippet).toContain("Zorzal");
    expect(snippet.line).toBeGreaterThan(20);
  });
  test("empty eligible set performs no Qdrant or model call", async () => {
    await addDoc(1, "draft");
    expect(await search({ key: "status", operator: "eq", value: "approved" })).toEqual([]);
    expect(requests).toHaveLength(0); expect(llm.embedBatch).not.toHaveBeenCalled();
  });
  test("rejects stale payloads rather than using wrong offsets or document identity", async () => {
    await addDoc(1, "approved"); points[0].payload.hash = "stale";
    expect(await search()).toEqual([]);
  });
  test("nested array predicates are resolved by the upstream typed compiler", async () => {
    await addDoc(1, "approved");
    expect(await search({ operator: "and", operands: [
      { key: "status", operator: "eq", value: "approved" },
      { key: "parties", operator: "all", value: ["Lucas Zorzal"] },
    ] })).toHaveLength(1);
  });
});
