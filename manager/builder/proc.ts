// Buffered child-process runner for build steps. Output is captured (not
// streamed) so a successful step stays quiet; on failure the engine prints
// the tail.

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  tail: string;
}

const TAIL_LINES = 40;

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (e) => {
      resolve({ code: 127, tail: e instanceof Error ? e.message : String(e) });
    });
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8");
      const lines = out.split("\n");
      resolve({ code: code ?? 1, tail: lines.slice(-TAIL_LINES).join("\n").trim() });
    });
  });
}

export async function runOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.code}\n${r.tail}`);
  }
}
