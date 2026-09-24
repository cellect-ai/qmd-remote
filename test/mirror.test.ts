/**
 * mirror.test.ts - `qmd mirror` tracking file and rsync invocation.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearMirrorConfig,
  isMirrorStale,
  loadMirrorConfig,
  mirrorRsyncArgs,
  saveMirrorConfig,
  syncMirror,
  type MirrorConfig,
} from "../src/mirror.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-mirror-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function stubRsync(name: string, script: string): Promise<string> {
  const path = join(testDir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("mirror", () => {
  test("rsync arguments copy directory contents and end option parsing", () => {
    expect(mirrorRsyncArgs("host:/srv/.qmd", "/tmp/m/.qmd")).toEqual([
      "-az", "--no-whole-file", "--inplace", "--exclude=*.backup-*", "--exclude=.mirror.json",
      "--", "host:/srv/.qmd/", "/tmp/m/.qmd/",
    ]);
  });

  test("rejects a source that rsync would parse as an option", () => {
    expect(() => mirrorRsyncArgs("-e sh", "/tmp/m/.qmd")).toThrow(/Invalid mirror source/);
    expect(() => mirrorRsyncArgs("", "/tmp/m/.qmd")).toThrow(/Invalid mirror source/);
  });

  test("a successful sync records lastSync in the tracking file", async () => {
    const qmdDir = join(testDir, "ok", ".qmd");
    await mkdir(qmdDir, { recursive: true });
    const argsFile = join(testDir, "ok-args");
    const rsync = await stubRsync("rsync-ok", `printf '%s\\n' "$@" > '${argsFile}'`);
    const config: MirrorConfig = { source: "host:/srv/.qmd", localPath: qmdDir, lastSync: null };
    saveMirrorConfig(qmdDir, config);

    await syncMirror(qmdDir, config, { rsync });
    const saved = loadMirrorConfig(qmdDir);
    expect(saved?.lastSync).toBeTruthy();
    expect(isMirrorStale(saved!)).toBe(false);
    expect((await readFile(argsFile, "utf8")).trim().split("\n").slice(-3)).toEqual(["--", "host:/srv/.qmd/", `${qmdDir}/`]);

    clearMirrorConfig(qmdDir);
    expect(loadMirrorConfig(qmdDir)).toBeNull();
  });

  test("a failed sync reports rsync stderr and leaves lastSync unset", async () => {
    const qmdDir = join(testDir, "fail", ".qmd");
    await mkdir(qmdDir, { recursive: true });
    const rsync = await stubRsync("rsync-fail", "echo 'connection refused' >&2; exit 12");
    const config: MirrorConfig = { source: "host:/srv/.qmd", localPath: qmdDir, lastSync: null };
    saveMirrorConfig(qmdDir, config);

    await expect(syncMirror(qmdDir, config, { rsync })).rejects.toThrow(/exit 12.*connection refused/s);
    expect(loadMirrorConfig(qmdDir)?.lastSync).toBeNull();
    expect(isMirrorStale(config)).toBe(true);
  });
});
