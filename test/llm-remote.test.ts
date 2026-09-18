import { afterEach, describe, expect, test, vi } from "vitest";
import { RemoteLLM } from "../src/llm-remote.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("RemoteLLM honest reranking", () => {
  test("never invents relevance when the server fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    const result = await new RemoteLLM({ rerankUrl: "http://rerank.test" }).rerank("person", [{ file: "tax", text: "unrelated" }]);
    expect(result.results).toEqual([]);
  });

  test("a failed later batch invalidates earlier scores instead of promoting arbitrary batch positions", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const docs = JSON.parse(String(init?.body)).documents;
      if (++calls === 2) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ results: docs.map((_: string, index: number) => ({ index, relevance_score: 0.1 })), model: "test" });
    }));
    const docs = Array.from({ length: 11 }, (_, i) => ({ file: String(i), text: "text" }));
    expect((await new RemoteLLM({ rerankUrl: "http://rerank.test" }).rerank("person", docs)).results).toEqual([]);
  });

  test("splits overflow batches and complete long documents, retaining a match in the second half", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const docs = JSON.parse(String(init?.body)).documents as string[];
      seen.push(docs);
      if (docs.length > 1 || docs.some(text => text.length > 150)) return Response.json({ error: { message: "input is too large to process. increase the physical batch size" } }, { status: 500 });
      return Response.json({ results: docs.map((text, index) => ({ index, relevance_score: text.includes("Zorzal") ? 0.9 : 0.1 })), model: "test" });
    }));
    const longText = "a".repeat(220) + "Zorzal";
    const result = await new RemoteLLM({ rerankUrl: "http://rerank.test" }).rerank("Zorzal", [{ file: "agreement", text: longText }, { file: "tax", text: "tax" }]);
    expect(result.results).toEqual([{ file: "agreement", index: 0, score: 0.9 }, { file: "tax", index: 1, score: 0.1 }]);
    expect(seen).toContainEqual([longText.slice(0, 113)]);
    expect(seen).toContainEqual([longText.slice(113)]);
  });

  test("rejects duplicate indices instead of accepting a partially scored candidate set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }] })));
    expect((await new RemoteLLM({ rerankUrl: "http://rerank.test" }).rerank("name", [{ file: "a", text: "a" }, { file: "b", text: "b" }])).results).toEqual([]);
  });
});

describe("RemoteLLM generation authorization", () => {
  test("uses the runtime-only generation API key for generation and health", async () => {
    vi.stubEnv("QMD_GENERATE_API_KEY", "runtime-product-key");
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ text: "lex: expanded query" }],
        model: "fast",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const llm = new RemoteLLM({ generateUrl: "http://generate.test", generateModel: "fast" });

    await expect(llm.generate("expand this")).resolves.toMatchObject({ model: "fast" });
    await llm.checkHealth();

    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer runtime-product-key");
    }
    expect(llm.getConfig()).not.toHaveProperty("generateApiKey");
  });
});

describe("RemoteLLM embedding sanitization", () => {
  test("embeds both complete halves on context overflow and normalizes their pooled vector", async () => {
    const inputs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string;
      inputs.push(input);
      if (input === "abcd") return Response.json({ error: { type: "exceed_context_size_error" } }, { status: 400 });
      return Response.json({ data: [{ embedding: input === "ab" ? [1, 0] : [0, 1] }], model: "embeddinggemma" });
    }));
    const result = await new RemoteLLM({ embedUrl: "http://embed.test" }).embed("abcd");
    expect(inputs).toEqual(["abcd", "ab", "cd"]);
    expect(result?.embedding[0]).toBeCloseTo(Math.SQRT1_2);
    expect(result?.embedding[1]).toBeCloseTo(Math.SQRT1_2);
  });

  test("does not split on unrelated server errors or invent a vector", async () => {
    const request = vi.fn(async () => Response.json({ error: "invalid model" }, { status: 400 }));
    vi.stubGlobal("fetch", request);
    expect(await new RemoteLLM({ embedUrl: "http://embed.test" }).embed("abcd")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("fails closed when either half has no usable vector", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input;
      return input === "abcd"
        ? Response.json({ error: { type: "exceed_context_size_error" } }, { status: 400 })
        : Response.json({ data: [{ embedding: [] }], model: "embeddinggemma" });
    }));
    expect(await new RemoteLLM({ embedUrl: "http://embed.test" }).embed("abcd")).toBeNull();
  });

  test("replaces unpaired UTF-16 surrogates before sending a batch", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.25] }],
        model: "embeddinggemma",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const llm = new RemoteLLM({ embedUrl: "http://embed.test" });

    await expect(llm.embedBatch([`before\uDC00after`])).resolves.toHaveLength(1);
    expect(requestBody).toContain("before�after");
    expect(requestBody).not.toContain("\\udc00");
  });
});
