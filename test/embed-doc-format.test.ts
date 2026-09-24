/**
 * embed-doc-format.test.ts - The cleaned document format must stay byte-for-byte
 * what central QMD (the pre-reconciliation fork `main`) embedded with, and the
 * default raw format must stay what the Rooms sidecars embedded with.
 */
import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { embedDocFormat, formatDocForEmbedding } from "../src/llm.js";
import { getEmbeddingFingerprint } from "../src/store.js";

type FormatCase = { text: string; title?: string; model: string; expected: string };

const fixture = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fork-embed-doc-format.json"),
  "utf8",
)) as { cases: FormatCase[] };

const NOMIC = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const original = process.env.QMD_EMBED_DOC_FORMAT;

afterEach(() => {
  if (original === undefined) delete process.env.QMD_EMBED_DOC_FORMAT;
  else process.env.QMD_EMBED_DOC_FORMAT = original;
});

describe("QMD_EMBED_DOC_FORMAT", () => {
  test("cleaned equals the fork main formatter for every fixture case", () => {
    process.env.QMD_EMBED_DOC_FORMAT = "cleaned";
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const item of fixture.cases) {
      expect(formatDocForEmbedding(item.text, item.title, item.model)).toBe(item.expected);
    }
  });

  test("raw is the default and keeps the upstream format", () => {
    delete process.env.QMD_EMBED_DOC_FORMAT;
    expect(embedDocFormat()).toBe("raw");
    expect(formatDocForEmbedding("a | b\n|--|", "T", NOMIC)).toBe("title: T | text: a | b\n|--|");
  });

  test("rejects an unknown format", () => {
    expect(() => embedDocFormat({ QMD_EMBED_DOC_FORMAT: "tidy" })).toThrow(/raw or cleaned/);
  });

  test("the fingerprint distinguishes cleaned vectors and keeps raw unchanged", () => {
    delete process.env.QMD_EMBED_DOC_FORMAT;
    const raw = getEmbeddingFingerprint(NOMIC);
    process.env.QMD_EMBED_DOC_FORMAT = "raw";
    expect(getEmbeddingFingerprint(NOMIC)).toBe(raw);
    process.env.QMD_EMBED_DOC_FORMAT = "cleaned";
    expect(getEmbeddingFingerprint(NOMIC)).not.toBe(raw);
  });
});
