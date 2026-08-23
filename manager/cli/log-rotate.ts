// Daemon log rotation. The daemon inherits an appended fd for its whole life, so
// the only safe moment to rotate is right before a start — an outside truncate
// would leave the running daemon writing at its old offset (a sparse file).
// Without this the log grew unbounded: one instance reached 649MB, most of it a
// single error repeating thousands of times per minute.

import { renameSync, rmSync, statSync } from "node:fs";

export const DAEMON_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const DAEMON_LOG_KEEP = 3;

/**
 * Renames `path` to `path.1` (shifting older generations up, dropping the
 * oldest) when it has grown past `maxBytes`. No-op when the file is absent or
 * still small. Returns true when a rotation happened.
 */
export function rotateIfLarge(path: string, maxBytes = DAEMON_LOG_MAX_BYTES, keep = DAEMON_LOG_KEEP): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  try { rmSync(`${path}.${keep}`, { force: true }); } catch {}
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch {}
  }
  try {
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}
