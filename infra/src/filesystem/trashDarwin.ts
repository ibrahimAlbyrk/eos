// Reversible delete. macOS → Finder Trash (real Trash, Finder "Put Back"
// works, nothing persisted by us). Non-darwin → move into ~/.eos-trash/ (still
// reversible; we never hard-delete). The path is passed to osascript as an
// `on run argv` argument — NEVER interpolated into the script string — so a
// path containing quotes can't break out of the AppleScript.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export async function trashViaFinder(path: string): Promise<void> {
  await execFileAsync(
    "osascript",
    [
      "-e", "on run argv",
      "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      "-e", "end run",
      path,
    ],
    { timeout: 15000 },
  );
}

// Fallback for non-darwin: relocate into a daemon-owned trash dir. A uuid
// prefix avoids collisions between same-named deletes.
export async function trashIntoDir(path: string, trashDir: string): Promise<void> {
  await mkdir(trashDir, { recursive: true });
  const dest = join(trashDir, `${randomUUID().slice(0, 8)}-${basename(path)}`);
  try {
    await rename(path, dest);
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "EXDEV") {
      await cp(path, dest, { recursive: true });
      await rm(path, { recursive: true, force: true });
      return;
    }
    throw e;
  }
}
