// fd gauge for the daemon, which supervises many PTYs + file watches and so can
// approach RLIMIT_NOFILE. `open` is the live descriptor count from /dev/fd
// (POSIX); `limit` is the soft RLIMIT_NOFILE. Node exposes no getrlimit binding,
// so the limit is read once via `ulimit -n` and cached — it cannot change after
// boot without a process re-exec.

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

let cachedLimit: number | null | undefined;

export function openFdCount(): number | null {
  try {
    // /dev/fd lists this process's open descriptors; subtract the one readdir
    // itself holds while listing. Linux/macOS only — null elsewhere.
    return Math.max(0, readdirSync("/dev/fd").length - 1);
  } catch {
    return null;
  }
}

export function softFdLimit(): number | null {
  if (cachedLimit !== undefined) return cachedLimit;
  try {
    const out = execFileSync("/bin/sh", ["-c", "ulimit -n"], { encoding: "utf8" }).trim();
    const n = Number(out);
    cachedLimit = Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    cachedLimit = null;
  }
  return cachedLimit;
}

export function fdStats(): { open: number | null; limit: number | null } {
  return { open: openFdCount(), limit: softFdLimit() };
}
