// GitEvidenceCollector — gathers the artifacts the judge grades: each criterion's
// verify command result (machine signal), the worker's whole-contribution git
// diff (fork-base..working-tree), AND the contents of any file the criteria
// reference. Reuses the GitInfo port for the diff; runs commands via the shared
// runShell; reads referenced files from disk ITSELF (never trusting the worker's
// prose about what a file contains). Every artifact is truncated so the bundle
// stays prompt-sized.

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { runShell, VERIFY_TIMEOUT_MS } from "./runShell.ts";
import type { EvidenceCollector, EvidenceBundle, MachineSignal, EvidenceFile } from "../../../core/src/ports/EvidenceCollector.ts";
import type { GoalContext } from "../../../core/src/ports/GoalCheckStrategy.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";
import type { GitInfo } from "../../../core/src/ports/GitInfo.ts";

const OUTPUT_CAP = 8000;
const DIFF_CAP = 40000;
const FILE_CAP = 8000;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 1024 * 1024;

export interface GitEvidenceCollectorDeps {
  git: Pick<GitInfo, "fullDiff">;
  repoRoot: string;
  // Reads a referenced artifact from disk. Default: node:fs (regular files only,
  // size-capped). Injected in tests. A reject IS the "file absent/unreadable"
  // signal — it yields no evidence for that path, so the judge stays fail-closed.
  readFile?: (path: string) => Promise<string>;
}

export class GitEvidenceCollector implements EvidenceCollector {
  private readonly deps: GitEvidenceCollectorDeps;

  constructor(deps: GitEvidenceCollectorDeps) {
    this.deps = deps;
  }

  async collect(goal: GoalSpec, ctx: GoalContext): Promise<EvidenceBundle> {
    // Verify commands + referenced files resolve against the worker's dir: its
    // worktree, else its checkout (a worker with no isolated worktree), else the
    // repo root (Fix 6a). Prefer the injected per-tick runner so a hybrid check
    // doesn't re-run each verify a second time (Fix 6b); fall back to runShell.
    const cwd = ctx.worktreeDir ?? ctx.cwd ?? this.deps.repoRoot;
    const run = (cmd: string): Promise<{ exitCode: number; output: string }> =>
      ctx.runCommand ? ctx.runCommand.run(cmd, cwd) : runShell(cmd, cwd, VERIFY_TIMEOUT_MS);

    const machineSignals: MachineSignal[] = [];
    for (const c of goal.criteria) {
      if (!c.verify) continue;
      const r = await run(c.verify);
      machineSignals.push({ criterionId: c.id, command: c.verify, exitCode: r.exitCode, output: truncate(r.output, OUTPUT_CAP) });
    }

    // The diff is collected only from an isolated worktree; a bare-checkout worker
    // reports "(no worktree — not collected)" downstream. diffBase is set ⇔ a
    // worktree diff was attempted, carrying the base for the judge payload header
    // and distinguishing empty-against-base from no-worktree (Fix 6d1).
    let diff: string | undefined;
    let diffBase: string | undefined;
    if (ctx.worktreeDir) {
      diffBase = ctx.forkBaseSha ?? "HEAD";
      const raw = await this.deps.git.fullDiff(ctx.worktreeDir, ctx.forkBaseSha).catch(() => null);
      if (raw && raw.length > 0) diff = truncate(raw, DIFF_CAP);
    }

    const files = await this.collectFiles(goal, cwd);

    return {
      machineSignals,
      ...(diff ? { diff } : {}),
      ...(diffBase ? { diffBase } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(ctx.lastReportText ? { reportClaim: ctx.lastReportText } : {}),
    };
  }

  // Reads files named by path tokens in the CRITERIA text (never the worker's
  // report) so a goal whose artifact lives outside the git worktree / has no
  // verify command still produces a real, collector-gathered signal.
  private async collectFiles(goal: GoalSpec, cwd: string): Promise<EvidenceFile[]> {
    const read = this.deps.readFile ?? defaultReadFile;
    const seen = new Set<string>();
    const files: EvidenceFile[] = [];
    for (const c of goal.criteria) {
      for (const token of extractPaths(c.text)) {
        if (files.length >= MAX_FILES) return files;
        const abs = resolve(cwd, expandTilde(token));
        if (seen.has(abs)) continue;
        seen.add(abs);
        try {
          files.push({ path: abs, content: truncate(await read(abs), FILE_CAP) });
        } catch {
          // absent/unreadable → no evidence for this path; judge stays fail-closed.
        }
      }
    }
    return files;
  }
}

async function defaultReadFile(path: string): Promise<string> {
  const st = await fsStat(path);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error("not a readable file");
  return fsReadFile(path, "utf8");
}

// Pull path-like tokens (those carrying a separator) out of a criterion's text.
// Bare filenames (no separator) are skipped on purpose — matching every
// "word.word" would catch version strings / prose; URLs are skipped too. A
// trailing sentence period or slash is trimmed so "... at /tmp/h.txt." resolves.
const PATH_TOKEN_RE = /[\w./~-]+/g;
function extractPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    if (m[0].includes("://") || m[0].startsWith("//")) continue;
    const t = m[0].replace(/[./]+$/, "");
    if (t.includes("/")) out.push(t);
  }
  return out;
}

// node:path.resolve does NOT expand '~' — expand a leading '~/' to the homedir
// so a criterion naming "~/x/y.txt" reads the real file instead of <cwd>/~/x/y.txt.
function expandTilde(token: string): string {
  return token.startsWith("~/") ? homedir() + token.slice(1) : token;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
