/**
 * mirror.ts - Remote index mirroring for QMD
 *
 * Allows maintaining a fast local copy of a remote .qmd index (e.g. on a
 * GPU server) while tracking the source and enabling incremental re-sync.
 *
 * Usage:
 *   qmd mirror <ssh-source> [local-path]   # set up + initial sync
 *   qmd mirror sync                         # re-sync from recorded source
 *   qmd mirror status                       # show source, last sync, staleness
 *   qmd mirror clear                        # remove tracking (keep local copy)
 */

import { join } from "path";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

// =============================================================================
// Types
// =============================================================================

export type MirrorConfig = {
  source: string;       // e.g. "user@gpu-host:/srv/agents/main/.qmd"
  localPath: string;    // absolute path to local .qmd dir
  lastSync: string | null;  // ISO 8601 timestamp
};

// =============================================================================
// Config storage (inside the local .qmd dir)
// =============================================================================

const MIRROR_FILE = ".mirror.json";

export function getMirrorConfigPath(qmdDir: string): string {
  return join(qmdDir, MIRROR_FILE);
}

export function loadMirrorConfig(qmdDir: string): MirrorConfig | null {
  const path = getMirrorConfigPath(qmdDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MirrorConfig;
  } catch {
    return null;
  }
}

export function saveMirrorConfig(qmdDir: string, config: MirrorConfig): void {
  writeFileSync(getMirrorConfigPath(qmdDir), JSON.stringify(config, null, 2));
}

export function clearMirrorConfig(qmdDir: string): void {
  const path = getMirrorConfigPath(qmdDir);
  if (existsSync(path)) unlinkSync(path);
}

// =============================================================================
// Staleness check
// =============================================================================

/**
 * Returns true if the mirror has never synced or was last synced more than
 * maxAgeHours ago (default: 23h, so a daily-changing index stays fresh).
 */
export function isMirrorStale(config: MirrorConfig, maxAgeHours = 23): boolean {
  if (!config.lastSync) return true;
  const ageMs = Date.now() - new Date(config.lastSync).getTime();
  return ageMs > maxAgeHours * 3600 * 1000;
}

export function mirrorAgeString(config: MirrorConfig): string {
  if (!config.lastSync) return "never synced";
  const ageMs = Date.now() - new Date(config.lastSync).getTime();
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// =============================================================================
// Sync
// =============================================================================

export type SyncOptions = {
  onProgress?: (line: string) => void;
  /** rsync executable; tests substitute a stub. */
  rsync?: string;
};

/** rsync arguments for one sync. Exported for tests. */
export function mirrorRsyncArgs(source: string, qmdDir: string): string[] {
  // A leading '-' would be parsed as an rsync option (for example `-e`).
  if (!source || source.startsWith("-")) throw new Error(`Invalid mirror source: ${source}`);
  // Ensure trailing slash on source so rsync copies contents, not the dir itself
  const from = source.endsWith("/") ? source : source + "/";
  const dest = qmdDir.endsWith("/") ? qmdDir : qmdDir + "/";
  return [
    "-az",
    "--no-whole-file",          // use block diffs (essential for large SQLite)
    "--inplace",                // update files in-place (also helps rsync diffs)
    "--exclude=*.backup-*",     // skip large backup snapshots
    "--exclude=.mirror.json",   // don't overwrite our tracking file
    "--",
    from,
    dest,
  ];
}

/**
 * rsync the remote source into qmdDir.
 * Uses --no-whole-file so rsync uses block-level diffs (fast for large SQLite
 * files where only the WAL changes). Excludes backup files.
 */
export async function syncMirror(
  qmdDir: string,
  config: MirrorConfig,
  opts: SyncOptions = {}
): Promise<void> {
  const args = mirrorRsyncArgs(config.source, qmdDir);
  const proc = spawn(opts.rsync ?? "rsync", args, { stdio: ["ignore", "ignore", "pipe"] });

  // Stream stderr (rsync progress/errors) to caller, keeping it for the error.
  let errText = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    errText += text;
    opts.onProgress?.(text);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`rsync failed (exit ${exitCode}): ${errText}`);
  }

  // Record successful sync time
  config.lastSync = new Date().toISOString();
  saveMirrorConfig(qmdDir, config);
}
