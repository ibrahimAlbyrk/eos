// Per-spawn system prompt synthesis. Worktree workers get a generated
// "Environment" section carrying the literal branch/dir facts plus the
// isolation contract, appended to the static prompt (if any). Written into
// the settings tmp dir so the existing teardown owns cleanup. Gated on
// worktree mode: plain-cwd workers keep their static prompt untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeContext } from "./worktree.ts";

export interface PromptContextInput {
  staticPromptFile: string | undefined;
  wt: WorktreeContext;
  tmpDir: string;
  name: string;
  workerId: string | undefined;
}

export function buildSystemPromptFile(input: PromptContextInput): string | undefined {
  const { wt } = input;
  if (!wt.worktreeDir || !wt.branch || !wt.repoRoot) return input.staticPromptFile;

  let staticPart = "";
  if (input.staticPromptFile) {
    try {
      staticPart = readFileSync(input.staticPromptFile, "utf8").trimEnd() + "\n\n";
    } catch {
      // Unreadable static prompt must not kill the spawn — ship the
      // environment section alone.
    }
  }

  const lines = [
    "# Environment",
    "",
    `- agent: ${input.name}${input.workerId ? ` (${input.workerId})` : ""}`,
    "- isolation: worktree",
    `- your working directory (an isolated git worktree): ${wt.worktreeDir}`,
    `- your git branch: ${wt.branch}`,
    `- the user's source checkout: ${wt.repoRoot}`,
    "",
    "## Workspace isolation rules",
    "",
    `You work in an ISOLATED git worktree on branch \`${wt.branch}\`, NOT in the user's checkout.`,
    "",
    "1. Your changes are INVISIBLE to the user's checkout and their running app",
    "   until the user integrates them. Never tell the user to run, test, or look",
    "   at anything in their own checkout to see your work.",
    `2. Never run commands in, or modify files under, the user's source checkout`,
    `   (${wt.repoRoot}). All work happens in your own working directory.`,
    "3. Verify your own work here (build, tests) before reporting, and end every",
    "   report with a Handover line:",
    `   \`Handover: branch ${wt.branch}; verified by <command + verdict: passed|failed|blocked|unverified>; to try: <command>\``,
  ];

  const path = join(input.tmpDir, "system-prompt.md");
  writeFileSync(path, staticPart + lines.join("\n") + "\n");
  return path;
}
