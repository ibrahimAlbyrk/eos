// EosHelper.exe (app/helper-win): the Windows twin of the macOS Swift helpers —
// DPAPI secrets, the Recycle Bin, keep-awake, location — one small native binary
// the desktop app ships and points the daemon at through EOS_HELPER_BIN.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

export function eosHelperPath(): string | null {
  const p = process.env.EOS_HELPER_BIN?.trim();
  return p && existsSync(p) ? p : null;
}

/** Runs one helper command to completion; throws when it fails or the helper is missing. */
export function runEosHelper(args: string[], input?: string): string {
  const bin = eosHelperPath();
  if (!bin) throw new Error("EosHelper.exe not found (EOS_HELPER_BIN)");
  return execFileSync(bin, args, { encoding: "utf8", input, windowsHide: true, timeout: 15_000 });
}

/** Starts a long-running helper command (keep-awake); null when the helper is missing. */
export function startEosHelper(args: string[]): ChildProcess | null {
  const bin = eosHelperPath();
  return bin ? spawn(bin, args, { stdio: "ignore", windowsHide: true }) : null;
}
