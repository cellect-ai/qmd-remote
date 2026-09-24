/**
 * remote-local.test.ts - `qmd --local` turns off the saved remote backend for
 * the process. The saved config path is fixed at import from HOME, so each
 * check runs in a child process with a private HOME.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "qmd-remote-local-"));
  await mkdir(join(home, ".cache", "qmd"), { recursive: true });
  await writeFile(join(home, ".cache", "qmd", "config.json"), JSON.stringify({ remote: { embedUrl: "http://127.0.0.1:9" } }));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function probe(disable: boolean): string {
  const script = join(home, `probe-${disable}.ts`);
  writeFileSync(script, `import { isRemoteConfigured, setRemoteDisabled } from ${JSON.stringify(join(projectRoot, "src", "llm-remote.ts"))};
${disable ? "setRemoteDisabled(true);" : ""}
console.log(String(isRemoteConfigured()));
`);
  return spawnSync(
    process.execPath,
    isBun ? [script] : [join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), script],
    { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000, cwd: projectRoot },
  ).stdout.trim();
}

test("a saved remote config is used unless --local disables it", () => {
  expect(probe(false)).toBe("true");
  expect(probe(true)).toBe("false");
});
