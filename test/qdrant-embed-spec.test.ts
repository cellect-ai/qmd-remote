/**
 * qdrant-embed-spec.test.ts - The Qdrant manifest records which document text
 * format (QMD_EMBED_DOC_FORMAT) built each document's vectors, and an import
 * that would mix formats in one alias fails before it embeds anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../src/db.js";
import {
  QDRANT_EMBED_SPEC,
  importQdrant,
  initializeManifest,
  qdrantEmbedSpec,
  reconcileManifestDocFormat,
} from "../src/qdrant-import.js";

let manifest: Database;

beforeEach(() => {
  manifest = openDatabase(":memory:");
  initializeManifest(manifest);
});

afterEach(() => {
  manifest.close();
});

function addRow(id: number, spec: string): void {
  manifest.prepare(`
    INSERT INTO qdrant_documents (document_id, hash, collection, point_count, embed_spec, chunk_spec, synced_at)
    VALUES (?, 'h', 'cellect_docs', 2, ?, 'c', 'now')
  `).run(id, spec);
}

function specs(): string[] {
  return (manifest.prepare(`SELECT DISTINCT embed_spec FROM qdrant_documents ORDER BY embed_spec`).all() as { embed_spec: string }[])
    .map(row => row.embed_spec);
}

describe("Qdrant embed spec includes the document format", () => {
  test("raw and cleaned specs differ and both name their format", () => {
    expect(qdrantEmbedSpec("raw")).toContain("raw");
    expect(qdrantEmbedSpec("cleaned")).toContain("cleaned");
    expect(qdrantEmbedSpec("raw")).not.toBe(qdrantEmbedSpec("cleaned"));
    expect(qdrantEmbedSpec({ QMD_EMBED_DOC_FORMAT: "cleaned" })).toBe(qdrantEmbedSpec("cleaned"));
  });

  test("a run without QMD_EMBED_DOC_FORMAT=cleaned against cleaned vectors fails loudly", () => {
    addRow(1, qdrantEmbedSpec("cleaned"));
    expect(() => reconcileManifestDocFormat(manifest, {})).toThrow(/QMD_EMBED_DOC_FORMAT=cleaned/);
    expect(() => reconcileManifestDocFormat(manifest, { QMD_EMBED_DOC_FORMAT: "raw" })).toThrow(/cleaned/);
    expect(reconcileManifestDocFormat(manifest, { QMD_EMBED_DOC_FORMAT: "cleaned" })).toBe(qdrantEmbedSpec("cleaned"));
  });

  test("a cleaned run against raw vectors fails loudly", () => {
    addRow(1, qdrantEmbedSpec("raw"));
    expect(() => reconcileManifestDocFormat(manifest, { QMD_EMBED_DOC_FORMAT: "cleaned" })).toThrow(/QMD_EMBED_DOC_FORMAT=raw/);
    expect(reconcileManifestDocFormat(manifest, {})).toBe(qdrantEmbedSpec("raw"));
  });

  test("unlabeled rows from before the format was recorded need an explicit format, then adopt it", () => {
    addRow(1, QDRANT_EMBED_SPEC);
    addRow(2, QDRANT_EMBED_SPEC);
    expect(() => reconcileManifestDocFormat(manifest, {})).toThrow(/before the document format was recorded/);
    expect(specs()).toEqual([QDRANT_EMBED_SPEC]);

    expect(reconcileManifestDocFormat(manifest, { QMD_EMBED_DOC_FORMAT: "cleaned" })).toBe(qdrantEmbedSpec("cleaned"));
    expect(specs()).toEqual([qdrantEmbedSpec("cleaned")]);
    // Once adopted, a raw run is refused like any other mismatch.
    expect(() => reconcileManifestDocFormat(manifest, {})).toThrow(/QMD_EMBED_DOC_FORMAT=cleaned/);
  });

  test("--rebuild re-embeds everything, so it may change the format", () => {
    addRow(1, qdrantEmbedSpec("cleaned"));
    addRow(2, QDRANT_EMBED_SPEC);
    expect(reconcileManifestDocFormat(manifest, {}, { rebuild: true })).toBe(qdrantEmbedSpec("raw"));
  });

  test("an empty manifest takes the configured format", () => {
    expect(reconcileManifestDocFormat(manifest, {})).toBe(qdrantEmbedSpec("raw"));
  });
});

describe("qmd qdrant-import", () => {
  test("refuses before embedding when the manifest holds the other format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qmd-embed-spec-"));
    const originalArgv = process.argv;
    const originalFormat = process.env.QMD_EMBED_DOC_FORMAT;
    try {
      const manifestPath = join(dir, "manifest.sqlite");
      const file = openDatabase(manifestPath);
      initializeManifest(file);
      file.prepare(`
        INSERT INTO qdrant_documents (document_id, hash, collection, point_count, embed_spec, chunk_spec, synced_at)
        VALUES (1, 'h', 'cellect_docs', 2, ?, 'c', 'now')
      `).run(qdrantEmbedSpec("cleaned"));
      file.close();
      delete process.env.QMD_EMBED_DOC_FORMAT;
      process.argv = [process.argv[0]!, "qdrant-import",
        "--db", join(dir, "index.sqlite"), "--manifest", manifestPath, "--state", join(dir, "state.json")];
      await expect(importQdrant()).rejects.toThrow(/QMD_EMBED_DOC_FORMAT=cleaned/);
    } finally {
      process.argv = originalArgv;
      if (originalFormat === undefined) delete process.env.QMD_EMBED_DOC_FORMAT;
      else process.env.QMD_EMBED_DOC_FORMAT = originalFormat;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
