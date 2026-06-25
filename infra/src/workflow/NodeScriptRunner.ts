// NodeScriptRunner — the infra adapter for the core ScriptRunner port (§ITEM 1).
// Runs a TRUSTED, allowlisted local script as a child process: the script id is
// resolved ONLY against operator-controlled allowlist dirs (`~/.eos/scripts`),
// NEVER an arbitrary path/command — absolute paths and `..` traversal are
// rejected. This resolution IS the trust boundary that keeps a `script` node from
// being arbitrary daemon code-exec. The workflow's JSON input is fed on stdin and
// as EOS_NODE_INPUT (Claude-Code-hook idiom); the process is killed on timeout (a
// timeout is a nonzero exit, not a throw — never throws). Node-only; the executor
// stays pure. Defaults (cwd, timeout) are resolved by the manager and injected
// here, so neither core nor this adapter reads config.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ScriptRunner, ScriptRunSpec, ScriptRunResult,
} from "../../../core/src/ports/ScriptRunner.ts";

// Cap captured output so one chatty script can't blow up memory.
const MAX_OUTPUT = 1024 * 1024;
const NOT_FOUND_EXIT = 126;   // resolution failure (not in an allowlisted dir)
const TIMEOUT_EXIT = 124;     // killed on timeout (GNU `timeout` convention)
const SPAWN_FAIL_EXIT = 1;

export interface NodeScriptRunnerOptions {
  // The allowlist: a script NAME resolves only to a file inside one of these dirs.
  scriptDirs: string[];
  defaultCwd: string;
  defaultTimeoutMs: number;
}

export class NodeScriptRunner implements ScriptRunner {
  private readonly scriptDirs: string[];
  private readonly defaultCwd: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: NodeScriptRunnerOptions) {
    this.scriptDirs = opts.scriptDirs.map((d) => resolve(d));
    this.defaultCwd = opts.defaultCwd;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
  }

  async run(spec: ScriptRunSpec): Promise<ScriptRunResult> {
    const scriptPath = this.resolveScript(spec.script);
    if (!scriptPath) {
      return {
        stdout: "",
        exitCode: NOT_FOUND_EXIT,
        stderr: `script "${spec.script}" not found in an allowlisted scripts dir`,
      };
    }
    const cwd = spec.cwd ?? this.defaultCwd;
    const timeoutMs = spec.timeoutMs && spec.timeoutMs > 0 ? spec.timeoutMs : this.defaultTimeoutMs;
    return this.exec(scriptPath, spec, cwd, timeoutMs);
  }

  // Resolve a script NAME to an absolute path WITHIN an allowlisted dir. Rejects
  // absolute paths and anything that escapes a dir via `..` — the trust boundary.
  private resolveScript(name: string): string | null {
    if (!name || isAbsolute(name)) return null;
    for (const dir of this.scriptDirs) {
      const candidate = resolve(dir, name);
      const rel = relative(dir, candidate);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private exec(scriptPath: string, spec: ScriptRunSpec, cwd: string, timeoutMs: number): Promise<ScriptRunResult> {
    return new Promise<ScriptRunResult>((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: ScriptRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveResult(result);
      };

      let child;
      try {
        child = spawn(scriptPath, spec.args, {
          cwd,
          env: { ...process.env, EOS_NODE_INPUT: spec.inputJson },
        });
      } catch (e) {
        finish({ stdout: "", exitCode: SPAWN_FAIL_EXIT, stderr: e instanceof Error ? e.message : String(e) });
        return;
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({
            stdout: cap(stdout),
            exitCode: TIMEOUT_EXIT,
            stderr: cap(`${stderr}\nscript timed out after ${timeoutMs}ms`.trim()),
          });
        }, timeoutMs);
      }

      child.stdout?.on("data", (d) => { stdout += String(d); });
      child.stderr?.on("data", (d) => { stderr += String(d); });
      child.on("error", (e) => finish({
        stdout: cap(stdout), exitCode: SPAWN_FAIL_EXIT, stderr: e instanceof Error ? e.message : String(e),
      }));
      child.on("close", (code) => finish({ stdout: cap(stdout), exitCode: code ?? SPAWN_FAIL_EXIT, stderr: cap(stderr) }));

      // Feed the JSON input on stdin; ignore EPIPE if the script never reads it.
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(spec.inputJson);
      }
    });
  }
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : s;
}
