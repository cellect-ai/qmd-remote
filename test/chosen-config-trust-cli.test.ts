/**
 * Trust gate for configs the CLI is pointed at rather than ones it discovers.
 *
 * A directory chosen with --qmd-dir, saved by `qmd init <path>`, written into
 * config.json by hand, or created by `qmd mirror` is somebody else's config
 * until approved, whatever the directory is called. A config directory the
 * deployment names with QMD_CONFIG_DIR is the operator's own, like the global
 * config, and runs without `qmd trust`.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runnerArgs = isBunRuntime ? [qmdScript] : [tsxCli, qmdScript];

let root: string;
let home: string;
let docs: string;
let marker: string;

function run(args: string[], env: Record<string, string> = {}, cwd = root): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...runnerArgs, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        PWD: cwd,
        QMD_DOCTOR_DEVICE_PROBE: "0",
        INDEX_PATH: "",
        QMD_CONFIG_DIR: "",
        QMD_TRUST_UPDATE_HOOKS: "",
        QMD_TRUST_LOCAL_CONFIG: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, exitCode: code ?? 1 }));
  });
}

/** A config whose hook writes `marker` and whose collection lies outside its project. */
function hostileConfig(): string {
  return [
    "collections:",
    "  docs:",
    `    path: ${JSON.stringify(docs)}`,
    '    pattern: "**/*.md"',
    `    update: ${JSON.stringify(`echo ran > ${JSON.stringify(marker)}`)}`,
    "",
  ].join("\n");
}

function writeConfigDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.yml"), hostileConfig());
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qmd-chosen-cfg-"));
  home = join(root, "home");
  docs = join(root, "elsewhere", "docs");
  marker = join(root, "hook-ran.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "opt"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "readme.md"), "# Readme\n\nindexable\n");
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function expectGated(result: { stdout: string }): void {
  expect(existsSync(marker)).toBe(false);
  expect(result.stdout).toContain("defines update commands");
  expect(result.stdout).toContain("qmd trust");
}

describe("CLI-chosen, saved and mirrored config directories are gated", () => {
  test("--qmd-dir naming a directory that is not called .qmd", async () => {
    const dir = writeConfigDir(join(root, "project", "foo"));
    expectGated(await run(["update", "--qmd-dir", dir]));
  }, 120_000);

  test("a directory saved in config.json, by hand or by qmd init <path>", async () => {
    const dir = writeConfigDir(join(root, "project", "shared-index"));
    mkdirSync(join(home, ".cache", "qmd"), { recursive: true });
    writeFileSync(join(home, ".cache", "qmd", "config.json"), JSON.stringify({ qmdDir: dir }));
    expectGated(await run(["update"]));
  }, 120_000);

  test("a mirror whose local directory is named x.qmd", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const canned = writeConfigDir(join(root, "canned"));
    writeFileSync(join(bin, "rsync"), `#!/bin/sh\nfor last; do :; done\ncp ${JSON.stringify(join(canned, "index.yml"))} "\${last}index.yml"\n`);
    chmodSync(join(bin, "rsync"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };

    const mirror = await run(["mirror", "gpu:/srv/.qmd", join(root, "project", "x.qmd")], env);
    expect(mirror.exitCode).toBe(0);
    expectGated(await run(["update"], env));
  }, 120_000);

  test("after qmd trust the chosen directory's hook runs", async () => {
    const dir = writeConfigDir(join(root, "project", "foo"));
    expect((await run(["trust", "--qmd-dir", dir])).stdout).toContain("Trusted");
    const result = await run(["update", "--qmd-dir", dir]);
    expect(result.stdout).toContain("Running update command");
    expect(existsSync(marker)).toBe(true);
  }, 120_000);
});

describe("a config directory selected by the deployment environment", () => {
  test("QMD_CONFIG_DIR=<dir>/.qmd (central's image) indexes and runs hooks without qmd trust", async () => {
    const dir = writeConfigDir(join(root, "node", ".qmd"));
    const result = await run(["update"], { QMD_CONFIG_DIR: dir, INDEX_PATH: join(dir, "index.sqlite") }, join(root, "opt"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("qmd trust");
    expect(result.stdout).toContain("Running update command");
    expect(result.stdout).toContain("Indexed: 1 new");
    expect(existsSync(marker)).toBe(true);
  }, 120_000);

  test("the same directory chosen with --qmd-dir is still gated", async () => {
    const dir = writeConfigDir(join(root, "node", ".qmd"));
    expectGated(await run(["update", "--qmd-dir", dir], { QMD_CONFIG_DIR: dir }));
  }, 120_000);
});
