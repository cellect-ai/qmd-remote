/**
 * incremental-reindex.test.ts - Fork NFS indexing behaviour carried onto the
 * upstream lineage: opt-in mtime skip in one transaction, empty-file skip.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, reindexCollection, type Store } from "../src/store.js";

let testDir: string;
let store: Store;
let collectionDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-incremental-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store = createStore(join(testDir, `test-${id}.sqlite`));
  collectionDir = join(testDir, `coll-${id}`);
  await mkdir(collectionDir, { recursive: true });
});

afterEach(() => {
  store.close();
});

function body(path: string): string | undefined {
  return (store.db.prepare(`
    SELECT content.doc AS doc FROM documents d JOIN content ON content.hash = d.hash
    WHERE d.collection = 'notes' AND d.path = ? AND d.active = 1
  `).get(path) as { doc: string } | undefined)?.doc;
}

async function rewriteWithOldMtime(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  const past = new Date(Date.now() - 3_600_000);
  await utimes(path, past, past);
}

describe("reindexCollection incremental mode", () => {
  test("skips a known file whose mtime is not newer; a full pass re-reads it", async () => {
    const doc = join(collectionDir, "doc.md");
    await writeFile(doc, "# Doc\n\nfirst\n");
    expect((await reindexCollection(store, collectionDir, "**/*.md", "notes")).indexed).toBe(1);

    await rewriteWithOldMtime(doc, "# Doc\n\nsecond\n");
    const incremental = await reindexCollection(store, collectionDir, "**/*.md", "notes", { incremental: true });
    expect(incremental).toMatchObject({ indexed: 0, updated: 0, unchanged: 1, removed: 0 });
    expect(body("doc.md")).toContain("first");

    const full = await reindexCollection(store, collectionDir, "**/*.md", "notes");
    expect(full).toMatchObject({ updated: 1, unchanged: 0 });
    expect(body("doc.md")).toContain("second");
  });

  test("re-reads a file whose mtime is newer than the indexed row", async () => {
    const doc = join(collectionDir, "doc.md");
    await rewriteWithOldMtime(doc, "# Doc\n\nfirst\n");
    await reindexCollection(store, collectionDir, "**/*.md", "notes");

    await writeFile(doc, "# Doc\n\nsecond\n");
    const future = new Date(Date.now() + 60_000);
    await utimes(doc, future, future);
    const result = await reindexCollection(store, collectionDir, "**/*.md", "notes", { incremental: true });
    expect(result).toMatchObject({ updated: 1, unchanged: 0 });
    expect(body("doc.md")).toContain("second");
  });

  test("re-reads an unchanged-mtime file whose metadata extraction is stale", async () => {
    const doc = join(collectionDir, "doc.md");
    await rewriteWithOldMtime(doc, "---\nqmd:\n  metadata:\n    status: draft\n---\n\n# Doc\n");
    await reindexCollection(store, collectionDir, "**/*.md", "notes");
    store.db.exec(`UPDATE document_metadata SET extraction_version = -1`);

    await reindexCollection(store, collectionDir, "**/*.md", "notes", { incremental: true });
    const row = store.db.prepare(`SELECT extraction_version FROM document_metadata`).get() as { extraction_version: number };
    expect(row.extraction_version).not.toBe(-1);
  });

  test("still deactivates removed files and indexes new ones", async () => {
    await writeFile(join(collectionDir, "gone.md"), "# Gone\n");
    await reindexCollection(store, collectionDir, "**/*.md", "notes");
    await rm(join(collectionDir, "gone.md"));
    await writeFile(join(collectionDir, "new.md"), "# New\n");

    const result = await reindexCollection(store, collectionDir, "**/*.md", "notes", { incremental: true });
    expect(result).toMatchObject({ indexed: 1, removed: 1 });
    expect(body("gone.md")).toBeUndefined();
    expect(body("new.md")).toContain("New");
  });

  test("skips empty files without indexing them", async () => {
    await writeFile(join(collectionDir, "empty.md"), "");
    await writeFile(join(collectionDir, "full.md"), "# Full\n");
    for (const incremental of [false, true]) {
      const result = await reindexCollection(store, collectionDir, "**/*.md", "notes", { incremental });
      expect(result.skipped).toBe(0);
    }
    expect(body("empty.md")).toBeUndefined();
    expect(body("full.md")).toContain("Full");
  });
});
