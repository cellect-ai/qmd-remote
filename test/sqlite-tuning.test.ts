/**
 * sqlite-tuning.test.ts - The fork's index connection tuning (6e9adc6/77e4def)
 * applies to every store, alongside upstream's WAL and busy timeout.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-sqlite-tuning-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pragma(db: { prepare(sql: string): { get(): unknown } }, name: string): number | string {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number | string>;
  return Object.values(row)[0]!;
}

test("a store connection carries the fork's cache, mmap, temp-store and sync settings", () => {
  const store = createStore(join(dir, "index.sqlite"));
  try {
    expect(pragma(store.db, "journal_mode")).toBe("wal");
    expect(pragma(store.db, "synchronous")).toBe(1); // NORMAL
    expect(pragma(store.db, "cache_size")).toBe(-65536); // 64 MB
    expect(pragma(store.db, "mmap_size")).toBe(268435456); // 256 MB
    expect(pragma(store.db, "temp_store")).toBe(2); // MEMORY
    // Upstream's default already waits longer than the fork's 30 s.
    expect(Number(pragma(store.db, "busy_timeout"))).toBeGreaterThanOrEqual(30_000);
  } finally {
    store.close();
  }
});
