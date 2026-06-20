// ChildProcessBranchMerge — orchestrator fan-in adapter. Merges several worker
// worktree snapshots into the orchestrator's checkout in one pass, via plain
// git plumbing (execFile). No commit and no MERGE_HEAD is ever created: the
// merged result lands in the index + working tree (staged), and a genuine
// overlap is expressed as git's OWN unmerged index (stages 1/2/3) + conflict
// markers, so the existing conflict resolver renders it. Undo is a plain reset.
//
// Strategy:
//   1. Snapshot each worker (committed + uncommitted + untracked) into a commit
//      — same temp-index dance as ChildProcessBranchIntegration.createSnapshot.
//   2. Greedily STACK the snapshots that merge cleanly via `merge-tree
//      --write-tree` (synthetic merge commits give the next merge a sane base).
//   3. Materialize the clean stack into index+working tree, then merge the FIRST
//      genuinely conflicting snapshot with the canonical low-level merge
//      (`read-tree -m` → `checkout-index` → `merge-index git-merge-one-file`),
//      which leaves a real `UU` unmerged state + markers. Later conflicting
//      workers are returned `pending` — git holds one conflict at a time, so
//      they wait for the first to be resolved and the tool re-run.
//
// realpath note: same dance as the Try adapter — repoRoot arrives via expandPath
// (no realpath) while git reports realpath'd paths; canonicalize first.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BranchMerge,
  MergeWorkerRef,
  MergeWorkerResult,
  MergeAllResult,
} from "../../../core/src/ports/BranchMerge.ts";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

interface GitResult { code: number; stdout: string; stderr: string }

async function git(repoRoot: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", ["-C", repoRoot, ...args], {
      maxBuffer: MAX_BUFFER,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function uniq(xs: string[]): string[] { return [...new Set(xs)]; }

export interface BranchMergeInput {
  now(): number;
}

interface Snapshot { ref: MergeWorkerRef; sha: string }

export function createChildProcessBranchMerge(input: BranchMergeInput): BranchMerge {
  const { now } = input;

  /** Temp-index snapshot commit of the worktree's committed + uncommitted +
   *  untracked work, without touching its real index. Worktree gone → branch
   *  tip. null on failure or when the worktree matches HEAD (nothing to merge). */
  async function createSnapshot(ref: MergeWorkerRef): Promise<string | null> {
    const wt = ref.worktreeDir && existsSync(ref.worktreeDir) ? realpathOr(ref.worktreeDir) : null;
    if (!wt) {
      const tip = await git(realpathOr(ref.repoRoot), ["rev-parse", "--verify", "--quiet", ref.branch]);
      return tip.code === 0 && tip.stdout.trim() ? tip.stdout.trim() : null;
    }
    const tmpIndex = join(tmpdir(), `eos-merge-${ref.workerId}-${process.pid}-${now().toString(36)}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      if ((await git(wt, ["read-tree", "HEAD"], env)).code !== 0) return null;
      if ((await git(wt, ["add", "-A"], env)).code !== 0) return null;
      const tree = await git(wt, ["write-tree"], env);
      if (tree.code !== 0) return null;
      const head = await git(wt, ["rev-parse", "HEAD"]);
      const headTree = await git(wt, ["rev-parse", "HEAD^{tree}"]);
      if (head.code !== 0 || headTree.code !== 0) return null;
      if (tree.stdout.trim() === headTree.stdout.trim()) return null; // nothing to contribute
      const commit = await git(wt, [
        "commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", `eos integrate snapshot ${ref.workerId}`,
      ]);
      return commit.code === 0 ? commit.stdout.trim() : null;
    } finally {
      try { unlinkSync(tmpIndex); } catch { /* best effort */ }
    }
  }

  /** Cheap clean/conflict detection + merged tree, used while stacking. */
  async function mergeNames(realRoot: string, base: string, snap: string): Promise<{ supported: boolean; conflicts: string[]; mergedTree: string | null }> {
    const r = await git(realRoot, ["merge-tree", "--write-tree", "--name-only", base, snap]);
    if (r.code !== 0 && r.code !== 1) return { supported: false, conflicts: [], mergedTree: null };
    const lines = r.stdout.trim().split("\n");
    const mergedTree = lines[0]?.trim() || null;
    const conflicts: string[] = [];
    if (r.code === 1) {
      for (const line of lines.slice(1)) {
        if (line.trim() === "") break;
        conflicts.push(line.trim());
      }
    }
    return { supported: true, conflicts, mergedTree };
  }

  async function diffNames(realRoot: string, from: string, to: string): Promise<string[]> {
    const r = await git(realRoot, ["diff", "--name-only", from, to]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** Paths the merge would touch that already carry local edits — refuse rather
   *  than clobber the operator's own uncommitted work. */
  async function dirtyAmong(realRoot: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const r = await git(realRoot, ["status", "--porcelain", "--", ...paths]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  }

  async function lsFilesUnmerged(realRoot: string): Promise<string[]> {
    const r = await git(realRoot, ["ls-files", "-u"]);
    if (r.code !== 0) return [];
    const paths: string[] = [];
    for (const line of r.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab >= 0) paths.push(line.slice(tab + 1));
    }
    return uniq(paths);
  }

  async function checkoutPaths(realRoot: string, paths: string[]): Promise<void> {
    if (paths.length > 0) await git(realRoot, ["checkout-index", "-f", "--", ...paths]);
  }

  return {
    async mergeAll(checkout: string, refs: MergeWorkerRef[]): Promise<MergeAllResult> {
      const realRoot = realpathOr(checkout);
      const results: MergeWorkerResult[] = [];
      const fail = (detail: string): MergeAllResult => ({ ok: false, results, mergedFiles: [], conflictedFiles: [], detail });

      const head = await git(realRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(realRoot, ["rev-parse", "HEAD^{tree}"]);
      if (head.code !== 0 || headTree.code !== 0) return fail("not a git repo / no HEAD");

      // 1. Snapshot every worker; no snapshot → nothing to integrate.
      const snapshots: Snapshot[] = [];
      for (const ref of refs) {
        const sha = await createSnapshot(ref);
        if (sha) snapshots.push({ ref, sha });
        else results.push({ workerId: ref.workerId, branch: ref.branch, outcome: "skipped", files: [], reason: "no changes to integrate" });
      }
      if (snapshots.length === 0) return { ok: true, results, mergedFiles: [], conflictedFiles: [] };

      // 2. Greedily stack snapshots that merge cleanly against the running base.
      let base = { commit: head.stdout.trim(), tree: headTree.stdout.trim() };
      const merged: Array<{ snap: Snapshot; files: string[] }> = [];
      const conflicting: Snapshot[] = [];
      for (const snap of snapshots) {
        const m = await mergeNames(realRoot, base.commit, snap.sha);
        if (!m.supported) return fail("git >= 2.38 required (merge-tree --write-tree)");
        if (m.conflicts.length === 0 && m.mergedTree) {
          const files = await diffNames(realRoot, base.tree, m.mergedTree);
          const wrap = await git(realRoot, ["commit-tree", m.mergedTree, "-p", base.commit, "-p", snap.sha, "-m", "eos integrate stack"]);
          if (wrap.code !== 0) return fail("stack commit-tree failed");
          base = { commit: wrap.stdout.trim(), tree: m.mergedTree };
          merged.push({ snap, files });
        } else {
          conflicting.push(snap);
        }
      }

      const cleanFiles = await diffNames(realRoot, "HEAD", base.tree);
      const confWorker = conflicting[0] ?? null;
      const confTree = confWorker ? (await git(realRoot, ["rev-parse", `${confWorker.sha}^{tree}`])).stdout.trim() : "";
      const confFiles = confWorker ? await diffNames(realRoot, "HEAD", confTree) : [];

      // Nothing changes the tree (e.g. snapshots re-create existing content).
      const touched = uniq([...cleanFiles, ...confFiles]);
      if (touched.length === 0) {
        for (const m of merged) results.push({ workerId: m.snap.ref.workerId, branch: m.snap.ref.branch, outcome: "merged", files: m.files });
        return { ok: true, results, mergedFiles: [], conflictedFiles: [] };
      }

      // 3. Preflight: never overwrite the operator's own uncommitted edits.
      const dirty = await dirtyAmong(realRoot, touched);
      if (dirty.length > 0) {
        return fail(`checkout has local changes to: ${dirty.slice(0, 10).join(", ")} — commit or stash before integrating`);
      }

      // 4. Materialize the clean stack into index + working tree (staged).
      if (cleanFiles.length > 0) {
        if ((await git(realRoot, ["read-tree", base.tree])).code !== 0) return fail("read-tree (clean stack) failed");
        await checkoutPaths(realRoot, cleanFiles);
      }

      // 5. Merge the first conflicting worker with the real low-level merge so it
      // leaves a genuine UU unmerged state + markers (not a synthetic index).
      let conflictedPaths: string[] = [];
      if (confWorker) {
        const mb = await git(realRoot, ["merge-base", base.commit, confWorker.sha]);
        const baseTree = mb.code === 0 && mb.stdout.trim()
          ? (await git(realRoot, ["rev-parse", `${mb.stdout.trim().split("\n")[0]}^{tree}`])).stdout.trim()
          : headTree.stdout.trim();
        const rt = await git(realRoot, ["read-tree", "-m", "-i", baseTree, base.tree, confTree]);
        if (rt.code !== 0) return fail(`read-tree -m failed: ${rt.stderr.trim() || "unknown"}`);
        conflictedPaths = await lsFilesUnmerged(realRoot);
        // Write the cleanly-merged (stage-0) files; merge-index writes markers
        // for the unmerged ones. Explicit paths only — never clobber unrelated work.
        await checkoutPaths(realRoot, touched.filter((p) => !conflictedPaths.includes(p)));
        await git(realRoot, ["merge-index", "-o", "git-merge-one-file", "-a"]); // exit 1 on conflict — expected
      }

      // 6. Per-worker outcomes.
      for (const m of merged) {
        results.push({ workerId: m.snap.ref.workerId, branch: m.snap.ref.branch, outcome: "merged", files: m.files });
      }
      if (confWorker) {
        results.push({ workerId: confWorker.ref.workerId, branch: confWorker.ref.branch, outcome: "conflicted", files: conflictedPaths });
        for (const p of conflicting.slice(1)) {
          results.push({ workerId: p.ref.workerId, branch: p.ref.branch, outcome: "pending", files: [], reason: "resolve the active conflict, then re-run" });
        }
      }

      return { ok: true, results, mergedFiles: uniq(merged.flatMap((m) => m.files)), conflictedFiles: conflictedPaths };
    },
  };
}
