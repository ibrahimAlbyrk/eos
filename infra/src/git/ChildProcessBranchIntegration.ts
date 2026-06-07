// ChildProcessBranchIntegration — unstaged Try adapter. All git work is plain
// plumbing via execFile; no merge state is ever created in the user's checkout
// (`git apply` verifies every hunk before writing, so a failed apply leaves
// the tree untouched). Discard is a reverse patch — context-anchored, so it
// stays valid even if HEAD moves during the try — guarded by per-file hash
// verification against the recorded post-apply hashes.
//
// realpath note: same dance as ChildProcessWorktreeManager — repoRoot arrives
// via expandPath (no realpath) while git reports realpath'd paths; canonicalize
// before deriving anything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BranchIntegration,
  TryRef,
  TryPreview,
  TryApplyResult,
  TryDiscardResult,
  ActiveTry,
} from "../../../core/src/ports/BranchIntegration.ts";

const exec = promisify(execFile);

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]);

interface GitResult { code: number; stdout: string; stderr: string }

async function git(repoRoot: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", ["-C", repoRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
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

function repoKey(realRoot: string): string {
  return realRoot.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function snapshotRef(workerId: string): string {
  return `refs/eos/snapshots/${workerId}`;
}

interface TryStateFile {
  workerId: string;
  branch: string;
  baseHead: string;
  lockfileChanged: boolean;
  createdAt: number;
  files: Array<{ path: string; hash: string | null }>;
}

export interface BranchIntegrationInput {
  triesDir: string;
  now(): number;
}

export function createChildProcessBranchIntegration(input: BranchIntegrationInput): BranchIntegration {
  const { triesDir, now } = input;
  // Per-repo serialization: concurrent apply/discard on the same checkout
  // would interleave git writes.
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  const stateDirFor = (realRoot: string): string => join(triesDir, repoKey(realRoot));
  const statePathFor = (realRoot: string): string => join(stateDirFor(realRoot), "try.json");
  const patchPathFor = (realRoot: string): string => join(stateDirFor(realRoot), "try.patch");
  const keptPathFor = (realRoot: string): string => join(stateDirFor(realRoot), "kept.json");

  function loadState(realRoot: string): TryStateFile | null {
    try {
      return JSON.parse(readFileSync(statePathFor(realRoot), "utf8")) as TryStateFile;
    } catch {
      return null;
    }
  }

  // Remove only the active-try files — kept.json (per-worker integration
  // markers) survives every clear.
  function clearTryFiles(realRoot: string): void {
    try { rmSync(statePathFor(realRoot), { force: true }); } catch {}
    try { rmSync(patchPathFor(realRoot), { force: true }); } catch {}
  }

  function loadKept(realRoot: string): Record<string, number> {
    try {
      return JSON.parse(readFileSync(keptPathFor(realRoot), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  function toActiveTry(s: TryStateFile): ActiveTry {
    return {
      workerId: s.workerId,
      branch: s.branch,
      baseHead: s.baseHead,
      files: s.files.map((f) => f.path),
      lockfileChanged: s.lockfileChanged,
      createdAt: s.createdAt,
    };
  }

  /** Temp-index snapshot: capture the worktree's committed + uncommitted +
   *  untracked (gitignore-respecting) work without touching its tree or index.
   *  Worktree gone → the branch tip is the snapshot. Pins the result at
   *  refs/eos/snapshots/<workerId> and returns the sha. */
  async function snapshot(ref: TryRef, realRoot: string): Promise<string | null> {
    const wt = ref.worktreeDir && existsSync(ref.worktreeDir) ? realpathOr(ref.worktreeDir) : null;
    let sha: string | null = null;

    if (wt) {
      const tmpIndex = join(tmpdir(), `eos-snap-${ref.workerId}-${process.pid}-${now().toString(36)}`);
      const env = { GIT_INDEX_FILE: tmpIndex };
      try {
        if ((await git(wt, ["read-tree", "HEAD"], env)).code !== 0) return null;
        if ((await git(wt, ["add", "-A"], env)).code !== 0) return null;
        const tree = await git(wt, ["write-tree"], env);
        if (tree.code !== 0) return null;
        const head = await git(wt, ["rev-parse", "HEAD"]);
        const headTree = await git(wt, ["rev-parse", "HEAD^{tree}"]);
        if (head.code !== 0 || headTree.code !== 0) return null;
        if (tree.stdout.trim() === headTree.stdout.trim()) {
          sha = head.stdout.trim();
        } else {
          const commit = await git(wt, [
            "commit-tree", tree.stdout.trim(),
            "-p", head.stdout.trim(),
            "-m", `eos try snapshot ${ref.workerId}`,
          ]);
          if (commit.code !== 0) return null;
          sha = commit.stdout.trim();
        }
      } finally {
        try { unlinkSync(tmpIndex); } catch {}
      }
    } else {
      const tip = await git(realRoot, ["rev-parse", "--verify", ref.branch]);
      if (tip.code !== 0) return null;
      sha = tip.stdout.trim();
    }

    if ((await git(realRoot, ["update-ref", snapshotRef(ref.workerId), sha])).code !== 0) return null;
    return sha;
  }

  interface MergeComputation {
    supported: boolean;
    conflicts: string[];
    mergedTree: string | null;
  }

  async function computeMerge(realRoot: string, snapSha: string): Promise<MergeComputation> {
    const r = await git(realRoot, ["merge-tree", "--write-tree", "--name-only", "HEAD", snapSha]);
    if (r.code !== 0 && r.code !== 1) return { supported: false, conflicts: [], mergedTree: null };
    const lines = r.stdout.trim().split("\n");
    const mergedTree = lines[0]?.trim() || null;
    // With --name-only, conflicted paths follow the tree OID (until the blank
    // line that precedes informational messages).
    const conflicts: string[] = [];
    if (r.code === 1) {
      for (const line of lines.slice(1)) {
        if (line.trim() === "") break;
        conflicts.push(line.trim());
      }
    }
    return { supported: true, conflicts, mergedTree };
  }

  async function touchedFiles(realRoot: string, mergedTree: string): Promise<string[]> {
    const r = await git(realRoot, ["diff", "--name-only", "HEAD", mergedTree]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  function hasLockfile(files: string[]): boolean {
    return files.some((f) => LOCKFILES.has(f.split("/").pop() ?? f));
  }

  async function hashOf(realRoot: string, path: string): Promise<string | null> {
    if (!existsSync(join(realRoot, path))) return null;
    const r = await git(realRoot, ["hash-object", "--", path]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    async preview(ref: TryRef): Promise<TryPreview> {
      const realRoot = realpathOr(ref.repoRoot);
      const active = loadState(realRoot);
      const empty = (supported: boolean): TryPreview => ({
        supported, ahead: 0, behind: 0, conflicts: [], files: [], lockfileChanged: false,
        activeTry: active ? toActiveTry(active) : null,
      });

      const snapSha = await snapshot(ref, realRoot);
      if (!snapSha) return empty(false);

      const counts = await git(realRoot, ["rev-list", "--left-right", "--count", `HEAD...${snapSha}`]);
      const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
      const behind = Number.parseInt(behindStr ?? "0", 10) || 0;
      const ahead = Number.parseInt(aheadStr ?? "0", 10) || 0;

      const merge = await computeMerge(realRoot, snapSha);
      if (!merge.supported || !merge.mergedTree) return { ...empty(merge.supported), ahead, behind };

      const files = await touchedFiles(realRoot, merge.mergedTree);
      return {
        supported: true,
        ahead,
        behind,
        conflicts: merge.conflicts,
        files,
        lockfileChanged: hasLockfile(files),
        activeTry: active ? toActiveTry(active) : null,
      };
    },

    apply(ref: TryRef): Promise<TryApplyResult> {
      const realRoot = realpathOr(ref.repoRoot);
      return withLock(realRoot, async (): Promise<TryApplyResult> => {
        const active = loadState(realRoot);
        if (active) return { ok: false, reason: "active-try", detail: active.workerId };

        const snapSha = await snapshot(ref, realRoot);
        if (!snapSha) return { ok: false, reason: "git-error", detail: "snapshot failed" };

        const merge = await computeMerge(realRoot, snapSha);
        if (!merge.supported) return { ok: false, reason: "unsupported", detail: "git >= 2.38 required (merge-tree --write-tree)" };
        if (merge.conflicts.length > 0) return { ok: false, reason: "conflicts", files: merge.conflicts };
        if (!merge.mergedTree) return { ok: false, reason: "git-error", detail: "merge-tree produced no tree" };

        const files = await touchedFiles(realRoot, merge.mergedTree);
        if (files.length === 0) return { ok: false, reason: "nothing-to-apply" };

        // Precondition: only the touched files must be clean (tracked-modified
        // OR untracked — `??` rows count). The rest of the tree may be dirty.
        const status = await git(realRoot, ["status", "--porcelain", "--", ...files]);
        const dirty = status.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
        if (dirty.length > 0) return { ok: false, reason: "dirty-files", files: dirty };

        const baseHead = await git(realRoot, ["rev-parse", "HEAD"]);
        if (baseHead.code !== 0) return { ok: false, reason: "git-error", detail: baseHead.stderr };

        const patch = await git(realRoot, ["diff", "--binary", "HEAD", merge.mergedTree]);
        if (patch.code !== 0) return { ok: false, reason: "git-error", detail: "patch generation failed" };

        mkdirSync(stateDirFor(realRoot), { recursive: true });
        const patchPath = patchPathFor(realRoot);
        writeFileSync(patchPath, patch.stdout);

        // git apply verifies every hunk before writing — a failure here leaves
        // the tree untouched.
        const applied = await git(realRoot, ["apply", "--whitespace=nowarn", patchPath]);
        if (applied.code !== 0) {
          clearTryFiles(realRoot);
          return { ok: false, reason: "git-error", detail: applied.stderr.trim() };
        }

        const fileHashes: TryStateFile["files"] = [];
        for (const f of files) fileHashes.push({ path: f, hash: await hashOf(realRoot, f) });

        const state: TryStateFile = {
          workerId: ref.workerId,
          branch: ref.branch,
          baseHead: baseHead.stdout.trim(),
          lockfileChanged: hasLockfile(files),
          createdAt: now(),
          files: fileHashes,
        };
        writeFileSync(statePathFor(realRoot), JSON.stringify(state, null, 2));

        return { ok: true, files, lockfileChanged: state.lockfileChanged };
      });
    },

    discard(repoRoot: string): Promise<TryDiscardResult> {
      const realRoot = realpathOr(repoRoot);
      return withLock(realRoot, async (): Promise<TryDiscardResult> => {
        const state = loadState(realRoot);
        if (!state) return { ok: false, reason: "no-active-try" };

        // Per-file integrity: every touched file must still match its
        // post-apply hash (null = deleted by the patch, must still be absent).
        const edited: string[] = [];
        for (const f of state.files) {
          const current = await hashOf(realRoot, f.path);
          if (current !== f.hash) edited.push(f.path);
        }
        if (edited.length > 0) return { ok: false, reason: "user-edited", files: edited };

        const reversed = await git(realRoot, ["apply", "-R", "--whitespace=nowarn", patchPathFor(realRoot)]);
        if (reversed.code !== 0) return { ok: false, reason: "git-error", detail: reversed.stderr.trim() };

        await git(realRoot, ["update-ref", "-d", snapshotRef(state.workerId)]);
        clearTryFiles(realRoot);
        return { ok: true };
      });
    },

    keep(repoRoot: string): Promise<{ ok: boolean; reason?: string }> {
      const realRoot = realpathOr(repoRoot);
      return withLock(realRoot, async () => {
        const state = loadState(realRoot);
        if (!state) return { ok: false, reason: "no-active-try" };
        await git(realRoot, ["update-ref", "-d", snapshotRef(state.workerId)]);
        // Integration marker: Apply never re-offers this worker's work.
        // Discard intentionally never writes this.
        const kept = loadKept(realRoot);
        kept[state.workerId] = now();
        try {
          mkdirSync(stateDirFor(realRoot), { recursive: true });
          writeFileSync(keptPathFor(realRoot), JSON.stringify(kept));
        } catch {}
        clearTryFiles(realRoot);
        return { ok: true };
      });
    },

    async activeTry(repoRoot: string): Promise<ActiveTry | null> {
      const state = loadState(realpathOr(repoRoot));
      return state ? toActiveTry(state) : null;
    },

    async wasKept(input: { repoRoot: string; workerId: string }): Promise<boolean> {
      return input.workerId in loadKept(realpathOr(input.repoRoot));
    },

    async cleanupSnapshot(input: { repoRoot: string; workerId: string }): Promise<void> {
      await git(realpathOr(input.repoRoot), ["update-ref", "-d", snapshotRef(input.workerId)]);
    },
  };
}
