// ChildProcessBranchPush — executes one resolved push plan via the `git` binary.
// Always runs with `-C <cwd>`. Never throws: a non-zero git exit is classified
// from stderr into a PushExecReason the domain summarizer understands.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BranchPush, PushExec } from "../../../core/src/ports/BranchPush.ts";
import type { ActionablePushPlan, PushExecReason } from "../../../core/src/domain/push-plan.ts";

const exec = promisify(execFile);

function argsFor(plan: ActionablePushPlan): string[] {
  switch (plan.kind) {
    case "set-upstream":     return ["push", "-u", plan.remote, plan.branch];
    case "fast-forward":     return ["push", plan.remote, plan.branch];
    case "force-with-lease": return ["push", "--force-with-lease", plan.remote, plan.branch];
  }
}

// Order matters: a stale-lease rejection also prints "[rejected]", so test the
// lease/auth cases before the generic non-fast-forward "rejected" bucket.
function classify(stderr: string): PushExecReason {
  const s = stderr.toLowerCase();
  if (/stale info|force-with-lease|cannot lock ref|would clobber/.test(s)) return "lease-stale";
  if (/authentication|could not read username|permission denied|access denied|terminal prompts disabled|\b403\b/.test(s)) return "auth";
  if (/\brejected\b|fetch first|non-fast-forward|tip of your current branch is behind/.test(s)) return "rejected";
  return "failed";
}

export const childProcessBranchPush: BranchPush = {
  async push(cwd: string, plan: ActionablePushPlan): Promise<PushExec> {
    try {
      const { stdout, stderr } = await exec("git", ["-C", cwd, ...argsFor(plan)], {
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout, stderr, reason: "pushed" };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? (e instanceof Error ? e.message : String(e));
      return { ok: false, code, stdout, stderr, reason: classify(stderr) };
    }
  },
};
