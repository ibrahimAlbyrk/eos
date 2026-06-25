// Run a shell command, capturing its exit code + combined output. Shared by the
// deterministic strategy (exit 0 = met) and the evidence collector (raw signal
// for the judge). A non-zero exit, a timeout, or a spawn failure all resolve to a
// non-zero exitCode with the error text as output — never throws.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Cap captured output so one chatty command can't blow up the buffer; callers
// truncate further for the judge prompt.
const MAX_BUFFER = 1024 * 1024;

// Generous upper bound — a verify may run a full test suite. A timeout counts as
// a non-zero (unmet) result, not a crash.
export const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

export interface ShellResult {
  exitCode: number;
  output: string;
  // True only when `signal` cancelled the command before it finished — distinct
  // from a real non-zero exit. A fail-fast verify pass reads this to tell
  // "another criterion already failed, so I cancelled this one" apart from
  // "this command itself failed".
  aborted?: boolean;
}

export async function runShell(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await exec("/bin/sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal });
    return { exitCode: 0, output: combine(stdout, stderr) };
  } catch (e) {
    const err = e as { code?: unknown; name?: unknown; stdout?: string; stderr?: string };
    // signal-driven cancellation surfaces as an AbortError — not a verify failure.
    if (err.name === "AbortError" || err.code === "ABORT_ERR") return { exitCode: -1, output: "aborted", aborted: true };
    const exitCode = typeof err.code === "number" ? err.code : 1;
    const out = combine(err.stdout ?? "", err.stderr ?? "");
    return { exitCode, output: out || (e instanceof Error ? e.message : String(e)) };
  }
}

function combine(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((s) => s && s.length > 0).join("\n").trim();
}
