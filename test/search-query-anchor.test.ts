import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "../src/index.js";
import type { LLM } from "../src/llm.js";

afterEach(() => vi.unstubAllEnvs());
test.each(["zorzal", "Lucas Silva Zorzal", "I need subscription agreement for Mark for Jersey and Bright"])(
  "retains original query in lexical, vector and reranker input: %s", async query => {
    vi.stubEnv("QMD_QDRANT_URL", "http://qdrant.test");
    const llm = { expandQuery: vi.fn(async () => [
      { type: "hyde", text: "Unrelated tax form" },
      { type: "lex", text: "tax form" },
      { type: "lex", text: query.toUpperCase() },
    ]) } as unknown as LLM;
    const store = await createStore({ dbPath: ":memory:", llm });
    try {
      const result = await store.expandQuery(query);
      expect(result.slice(0, 2)).toEqual([{ type: "lex", query }, { type: "vec", query }]);
      expect(result.filter(item => item.type === "lex" && item.query.toLowerCase() === query.toLowerCase())).toHaveLength(1);
      expect(result.find(item => item.type === "lex")?.query).toBe(query);
    } finally { await store.close(); }
  },
);
