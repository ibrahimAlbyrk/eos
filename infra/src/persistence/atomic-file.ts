// File helpers for user data under ~/.eos: a crash-safe write (sibling .tmp, then
// rename over the target, so a reader never sees a half-written file) and a soft
// delete into the directory's .trash/ (recoverable by hand).

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// <dir>/<name>.<ext> → <dir>/.trash/<name>.<timestamp>.<ext>; a missing file is a no-op.
export function moveToTrash(dir: string, name: string, ext: string): void {
  const path = join(dir, `${name}.${ext}`);
  if (!existsSync(path)) return;
  const trash = join(dir, ".trash");
  mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  renameSync(path, join(trash, `${name}.${stamp}.${ext}`));
}
