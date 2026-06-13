// ChildProcessBranchIntegration — unstaged Try adapter. All git work is plain
// plumbing via execFile; no merge state is ever created in the user's checkout
// (`git apply` verifies every hunk before writing, so a failed apply leaves
// the tree untouched). Discard is a reverse patch — context-anchored, so it
// stays valid even if HEAD moves during the try — guarded by per-file hash
// verification against the recorded post-apply hashes.
//
// Tries stack (tries.json, bottom first). A new layer's patch is the diff
// between the stack's virtual tree (HEAD + every active snapshot merged in
// order via synthetic commits) and that tree merged with the new snapshot, so
// concurrent tries from different workers compose. Keep is tree-neutral and
// order-free; discard is refused while a layer above touches the same files
// (reverse-applying under an overlay would corrupt the upper layer's content).
//
// realpath note: same dance as ChildProcessWorktreeManager — repoRoot arrives
// via expandPath (no realpath) while git reports realpath'd paths; canonicalize
// before deriving anything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, renameSync } from "node:fs";
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

function fsKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function snapshotRef(workerId: string): string {
  return `refs/eos/snapshots/${workerId}`;
}

interface TryStateFile {
  workerId: string;
  branch: string;
  baseHead: string;
  /** Pinned snapshot commit — also the re-sync anchor (the worktree state this
   *  layer currently represents) and the stack-rebuild fallback if the ref is
   *  gone. */
  snapshotSha?: string;
  /** Accepted by the user: out of the Keep/Discard deck but still in the stack
   *  and still syncable. */
  kept?: boolean;
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

  const stateDirFor = (realRoot: string): string => join(triesDir, fsKey(realRoot));
  const triesPathFor = (realRoot: string): string => join(stateDirFor(realRoot), "tries.json");
  const patchPathFor = (realRoot: string, workerId: string): string =>
    join(stateDirFor(realRoot), `${fsKey(workerId)}.patch`);
  const keptPathFor = (realRoot: string): string => join(stateDirFor(realRoot), "kept.json");

  // Legacy single-try layout (try.json + try.patch) → one-element stack.
  function migrateLegacy(realRoot: string): void {
    const legacyState = join(stateDirFor(realRoot), "try.json");
    if (!existsSync(legacyState) || existsSync(triesPathFor(realRoot))) return;
    try {
      const legacy = JSON.parse(readFileSync(legacyState, "utf8")) as TryStateFile;
      const legacyPatch = join(stateDirFor(realRoot), "try.patch");
      if (existsSync(legacyPatch)) renameSync(legacyPatch, patchPathFor(realRoot, legacy.workerId));
      writeFileSync(triesPathFor(realRoot), JSON.stringify([legacy], null, 2));
      rmSync(legacyState, { force: true });
    } catch {}
  }

  function loadTries(realRoot: string): TryStateFile[] {
    migrateLegacy(realRoot);
    try {
      const parsed = JSON.parse(readFileSync(triesPathFor(realRoot), "utf8")) as TryStateFile[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // kept.json (per-worker integration markers) survives every save/clear.
  function saveTries(realRoot: string, tries: TryStateFile[]): void {
    if (tries.length === 0) {
      try { rmSync(triesPathFor(realRoot), { force: true }); } catch {}
      return;
    }
    mkdirSync(stateDirFor(realRoot), { recursive: true });
    writeFileSync(triesPathFor(realRoot), JSON.stringify(tries, null, 2));
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

  /** Temp-index snapshot commit: capture the worktree's committed + uncommitted
   *  + untracked (gitignore-respecting) work without touching its tree or index.
   *  Worktree gone → the branch tip is the snapshot. Returns the sha but does
   *  NOT pin it — apply pins on success so the ref and the recorded snapshotSha
   *  never diverge after a mid-apply failure. */
  async function createSnapshot(ref: TryRef, realRoot: string): Promise<string | null> {
    const wt = ref.worktreeDir && existsSync(ref.worktreeDir) ? realpathOr(ref.worktreeDir) : null;

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
        if (tree.stdout.trim() === headTree.stdout.trim()) return head.stdout.trim();
        const commit = await git(wt, [
          "commit-tree", tree.stdout.trim(),
          "-p", head.stdout.trim(),
          "-m", `eos try snapshot ${ref.workerId}`,
        ]);
        return commit.code === 0 ? commit.stdout.trim() : null;
      } finally {
        try { unlinkSync(tmpIndex); } catch {}
      }
    }
    const tip = await git(realRoot, ["rev-parse", "--verify", ref.branch]);
    return tip.code === 0 ? tip.stdout.trim() : null;
  }

  /** The worktree's current tree only (no commit, no ref) — for the cheap,
   *  side-effect-free "did the worktree advance?" check behind syncStatus. */
  async function worktreeTreeSha(ref: TryRef, realRoot: string): Promise<string | null> {
    const wt = ref.worktreeDir && existsSync(ref.worktreeDir) ? realpathOr(ref.worktreeDir) : null;
    if (!wt) {
      const tip = await git(realRoot, ["rev-parse", "--verify", `${ref.branch}^{tree}`]);
      return tip.code === 0 ? tip.stdout.trim() : null;
    }
    const tmpIndex = join(tmpdir(), `eos-sync-${ref.workerId}-${process.pid}-${now().toString(36)}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      if ((await git(wt, ["read-tree", "HEAD"], env)).code !== 0) return null;
      if ((await git(wt, ["add", "-A"], env)).code !== 0) return null;
      const tree = await git(wt, ["write-tree"], env);
      return tree.code === 0 ? tree.stdout.trim() : null;
    } finally {
      try { unlinkSync(tmpIndex); } catch {}
    }
  }

  /** Blob sha of a path inside a tree (null if absent) — comparable to hashOf's
   *  working-tree blob sha, so a re-sync can verify the checkout still holds the
   *  previously-applied content before patching. */
  async function blobInTree(realRoot: string, tree: string, path: string): Promise<string | null> {
    const r = await git(realRoot, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  interface MergeComputation {
    supported: boolean;
    conflicts: string[];
    mergedTree: string | null;
  }

  async function computeMerge(realRoot: string, baseCommit: string, snapSha: string): Promise<MergeComputation> {
    const r = await git(realRoot, ["merge-tree", "--write-tree", "--name-only", baseCommit, snapSha]);
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

  interface StackBase { commit: string; tree: string }

  /** Virtual tree of HEAD + every active layer, merged in stack order. Each
   *  step is wrapped in a synthetic merge commit (parents: base + snapshot) so
   *  the next merge-tree finds a sane merge base. Ref-only — nothing in the
   *  checkout moves. */
  async function rebuildStack(realRoot: string, tries: TryStateFile[]): Promise<StackBase | { error: string }> {
    const head = await git(realRoot, ["rev-parse", "HEAD"]);
    const headTree = await git(realRoot, ["rev-parse", "HEAD^{tree}"]);
    if (head.code !== 0 || headTree.code !== 0) return { error: "rev-parse HEAD failed" };
    let base: StackBase = { commit: head.stdout.trim(), tree: headTree.stdout.trim() };

    for (const t of tries) {
      let snap = (await git(realRoot, ["rev-parse", "--verify", "--quiet", snapshotRef(t.workerId)])).stdout.trim();
      if (!snap && t.snapshotSha) {
        const ok = await git(realRoot, ["cat-file", "-e", `${t.snapshotSha}^{commit}`]);
        if (ok.code === 0) snap = t.snapshotSha;
      }
      if (!snap) return { error: `snapshot for active try ${t.workerId} is gone — keep or discard it first` };

      const m = await computeMerge(realRoot, base.commit, snap);
      if (!m.supported || !m.mergedTree || m.conflicts.length > 0) {
        return { error: `active try ${t.workerId} no longer merges cleanly against HEAD — keep or discard it first` };
      }
      const wrap = await git(realRoot, ["commit-tree", m.mergedTree, "-p", base.commit, "-p", snap, "-m", "eos try stack"]);
      if (wrap.code !== 0) return { error: "stack commit-tree failed" };
      base = { commit: wrap.stdout.trim(), tree: m.mergedTree };
    }
    return base;
  }

  async function touchedFiles(realRoot: string, fromTree: string, toTree: string): Promise<string[]> {
    const r = await git(realRoot, ["diff", "--name-only", fromTree, toTree]);
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

  /** Topmost layer's recorded post-apply hash per path — the expected current
   *  content of any file an active layer touches. */
  function expectedHashes(tries: TryStateFile[]): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const t of tries) for (const f of t.files) map.set(f.path, f.hash);
    return map;
  }

  return {
    async preview(ref: TryRef): Promise<TryPreview> {
      const realRoot = realpathOr(ref.repoRoot);
      const activeTries = loadTries(realRoot).filter((t) => !t.kept).map(toActiveTry);
      const empty = (supported: boolean): TryPreview => ({
        supported, ahead: 0, behind: 0, conflicts: [], files: [], lockfileChanged: false, activeTries,
      });

      const snapSha = await createSnapshot(ref, realRoot);
      if (!snapSha) return empty(false);

      const counts = await git(realRoot, ["rev-list", "--left-right", "--count", `HEAD...${snapSha}`]);
      const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
      const behind = Number.parseInt(behindStr ?? "0", 10) || 0;
      const ahead = Number.parseInt(aheadStr ?? "0", 10) || 0;

      const merge = await computeMerge(realRoot, "HEAD", snapSha);
      if (!merge.supported || !merge.mergedTree) return { ...empty(merge.supported), ahead, behind };

      const files = await touchedFiles(realRoot, "HEAD", merge.mergedTree);
      return {
        supported: true,
        ahead,
        behind,
        conflicts: merge.conflicts,
        files,
        lockfileChanged: hasLockfile(files),
        activeTries,
      };
    },

    apply(ref: TryRef): Promise<TryApplyResult> {
      const realRoot = realpathOr(ref.repoRoot);
      return withLock(realRoot, async (): Promise<TryApplyResult> => {
        const tries = loadTries(realRoot);
        // Idempotent: an existing layer (provisional OR kept) means re-sync, not
        // reject. Its floor = the layers below it; it is reprojected in place.
        const idx = tries.findIndex((t) => t.workerId === ref.workerId);
        const existing = idx >= 0 ? tries[idx]! : null;
        const below = idx >= 0 ? tries.slice(0, idx) : tries;

        const snapSha = await createSnapshot(ref, realRoot);
        if (!snapSha) return { ok: false, reason: "git-error", detail: "snapshot failed" };

        // Classify conflicts against plain HEAD first — those need the git
        // agent; conflicts that only appear against the stack need a layer
        // resolved instead.
        const headMerge = await computeMerge(realRoot, "HEAD", snapSha);
        if (!headMerge.supported) return { ok: false, reason: "unsupported", detail: "git >= 2.38 required (merge-tree --write-tree)" };
        if (headMerge.conflicts.length > 0) return { ok: false, reason: "conflicts", files: headMerge.conflicts };
        if (!headMerge.mergedTree) return { ok: false, reason: "git-error", detail: "merge-tree produced no tree" };

        const base = await rebuildStack(realRoot, below);
        if ("error" in base) return { ok: false, reason: "git-error", detail: base.error };

        let mergedTree = headMerge.mergedTree;
        if (below.length > 0) {
          const m = await computeMerge(realRoot, base.commit, snapSha);
          if (!m.supported || !m.mergedTree) return { ok: false, reason: "git-error", detail: "stack merge-tree failed" };
          if (m.conflicts.length > 0) {
            const owners = below
              .filter((t) => t.files.some((f) => m.conflicts.includes(f.path)))
              .map((t) => t.workerId);
            return { ok: false, reason: "conflicts-with-try", files: m.conflicts, detail: owners.join(",") || below[below.length - 1]!.workerId };
          }
          mergedTree = m.mergedTree;
        }

        // Full set of files this layer contributes over its floor — recorded so
        // discard can reverse the whole layer and integrity-check every file.
        const layerFiles = await touchedFiles(realRoot, base.tree, mergedTree);
        if (layerFiles.length === 0) return { ok: false, reason: "nothing-to-apply" };

        // fromTree = the checkout state we patch FROM; deltaFiles = what this
        // call actually changes (the whole layer on first apply, only the new
        // worktree progress on a re-sync).
        let fromTree: string;
        let deltaFiles: string[];
        if (existing) {
          // Reproject the previously-applied snapshot onto the same floor, then
          // patch only the diff to the new projection.
          const prev = await computeMerge(realRoot, base.commit, existing.snapshotSha ?? "");
          if (!prev.supported || !prev.mergedTree || prev.conflicts.length > 0) {
            return { ok: false, reason: "git-error", detail: "previous snapshot no longer projects cleanly — discard and re-apply" };
          }
          fromTree = prev.mergedTree;
          deltaFiles = await touchedFiles(realRoot, prev.mergedTree, mergedTree);
          if (deltaFiles.length === 0) return { ok: false, reason: "nothing-to-apply" };
          // A layer above sharing a delta file would be corrupted by reprojecting
          // this one — resolve it first (same invariant as discard).
          for (const above of tries.slice(idx + 1)) {
            const overlap = above.files.map((f) => f.path).filter((p) => deltaFiles.includes(p));
            if (overlap.length > 0) return { ok: false, reason: "blocked-by-overlay", files: overlap, detail: above.workerId };
          }
          // The checkout must still hold the previously-applied content for every
          // file we touch — never silently clobber a manual edit.
          const dirty: string[] = [];
          for (const f of deltaFiles) {
            if ((await hashOf(realRoot, f)) !== (await blobInTree(realRoot, prev.mergedTree, f))) dirty.push(f);
          }
          if (dirty.length > 0) return { ok: false, reason: "dirty-files", files: dirty };
        } else {
          // First apply: every touched file must hold its EXPECTED content — the
          // layer's post-apply hash if a layer below touches it, otherwise clean
          // per porcelain (`??` rows count). The rest of the tree may be dirty.
          fromTree = base.tree;
          deltaFiles = layerFiles;
          const expected = expectedHashes(below);
          const dirty: string[] = [];
          const unlayered: string[] = [];
          for (const f of layerFiles) {
            if (expected.has(f)) {
              if ((await hashOf(realRoot, f)) !== expected.get(f)) dirty.push(f);
            } else {
              unlayered.push(f);
            }
          }
          if (unlayered.length > 0) {
            const status = await git(realRoot, ["status", "--porcelain", "--", ...unlayered]);
            dirty.push(...status.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean));
          }
          if (dirty.length > 0) return { ok: false, reason: "dirty-files", files: dirty };
        }

        const baseHead = await git(realRoot, ["rev-parse", "HEAD"]);
        if (baseHead.code !== 0) return { ok: false, reason: "git-error", detail: baseHead.stderr };

        // Apply the minimal patch from a temp file — verify-all-then-write means
        // a failure leaves both the checkout and the stored patch untouched.
        const applyPatch = await git(realRoot, ["diff", "--binary", fromTree, mergedTree]);
        if (applyPatch.code !== 0) return { ok: false, reason: "git-error", detail: "patch generation failed" };
        mkdirSync(stateDirFor(realRoot), { recursive: true });
        const tmpPatch = join(stateDirFor(realRoot), `${fsKey(ref.workerId)}.apply.tmp`);
        writeFileSync(tmpPatch, applyPatch.stdout);
        const applied = await git(realRoot, ["apply", "--whitespace=nowarn", tmpPatch]);
        try { rmSync(tmpPatch, { force: true }); } catch {}
        if (applied.code !== 0) return { ok: false, reason: "git-error", detail: applied.stderr.trim() };

        // Persist the CUMULATIVE patch (floor → new) so discard reverses the
        // whole layer no matter how many syncs built it up.
        const cumulative = existing
          ? await git(realRoot, ["diff", "--binary", base.tree, mergedTree])
          : applyPatch;
        if (cumulative.code !== 0) return { ok: false, reason: "git-error", detail: "cumulative patch failed" };
        writeFileSync(patchPathFor(realRoot, ref.workerId), cumulative.stdout);

        // Pin the snapshot only now — ref and recorded snapshotSha stay in
        // lockstep, so a failed re-sync never strands a newer ref for the stack.
        await git(realRoot, ["update-ref", snapshotRef(ref.workerId), snapSha]);

        const fileHashes: TryStateFile["files"] = [];
        for (const f of layerFiles) fileHashes.push({ path: f, hash: await hashOf(realRoot, f) });

        const layer: TryStateFile = {
          workerId: ref.workerId,
          branch: ref.branch,
          baseHead: baseHead.stdout.trim(),
          snapshotSha: snapSha,
          kept: false,
          lockfileChanged: hasLockfile(layerFiles),
          createdAt: existing?.createdAt ?? now(),
          files: fileHashes,
        };
        if (idx >= 0) tries[idx] = layer; else tries.push(layer);
        saveTries(realRoot, tries);

        return { ok: true, files: deltaFiles, lockfileChanged: hasLockfile(deltaFiles) };
      });
    },

    discard(repoRoot: string, workerId: string): Promise<TryDiscardResult> {
      const realRoot = realpathOr(repoRoot);
      return withLock(realRoot, async (): Promise<TryDiscardResult> => {
        const tries = loadTries(realRoot);
        const idx = tries.findIndex((t) => t.workerId === workerId);
        if (idx < 0) return { ok: false, reason: "no-active-try" };
        const state = tries[idx]!;

        // A layer above sharing a file would be corrupted by this reverse
        // patch — that layer must be resolved first.
        const mine = new Set(state.files.map((f) => f.path));
        for (const above of tries.slice(idx + 1)) {
          const overlap = above.files.map((f) => f.path).filter((p) => mine.has(p));
          if (overlap.length > 0) return { ok: false, reason: "blocked-by-overlay", files: overlap, detail: above.workerId };
        }

        // Per-file integrity: every touched file must still match its
        // post-apply hash (null = deleted by the patch, must still be absent).
        const edited: string[] = [];
        for (const f of state.files) {
          const current = await hashOf(realRoot, f.path);
          if (current !== f.hash) edited.push(f.path);
        }
        if (edited.length > 0) return { ok: false, reason: "user-edited", files: edited };

        const patchPath = patchPathFor(realRoot, workerId);
        const reversed = await git(realRoot, ["apply", "-R", "--whitespace=nowarn", patchPath]);
        if (reversed.code !== 0) return { ok: false, reason: "git-error", detail: reversed.stderr.trim() };

        await git(realRoot, ["update-ref", "-d", snapshotRef(workerId)]);
        try { rmSync(patchPath, { force: true }); } catch {}
        tries.splice(idx, 1);
        saveTries(realRoot, tries);
        return { ok: true };
      });
    },

    keep(repoRoot: string, workerId: string): Promise<{ ok: boolean; reason?: string }> {
      const realRoot = realpathOr(repoRoot);
      return withLock(realRoot, async () => {
        const tries = loadTries(realRoot);
        const idx = tries.findIndex((t) => t.workerId === workerId);
        if (idx < 0) return { ok: false, reason: "no-active-try" };
        // Accept the layer: drop it from the Keep/Discard deck but leave it in
        // the stack (and its snapshot ref + patch in place) so its edits keep
        // counting as expected content and the worktree can still be re-synced.
        tries[idx]!.kept = true;
        saveTries(realRoot, tries);
        return { ok: true };
      });
    },

    async activeTries(repoRoot: string): Promise<ActiveTry[]> {
      return loadTries(realpathOr(repoRoot)).filter((t) => !t.kept).map(toActiveTry);
    },

    async wasKept(input: { repoRoot: string; workerId: string }): Promise<boolean> {
      const realRoot = realpathOr(input.repoRoot);
      const mine = loadTries(realRoot).find((t) => t.workerId === input.workerId);
      // Legacy kept.json (pre-flag keeps removed the layer) stays honoured.
      return mine?.kept === true || input.workerId in loadKept(realRoot);
    },

    async syncStatus(ref: TryRef): Promise<{ syncable: boolean; files: string[] }> {
      const realRoot = realpathOr(ref.repoRoot);
      const mine = loadTries(realRoot).find((t) => t.workerId === ref.workerId);
      // No anchor (never applied) → not a re-sync; the UI offers a first Apply.
      if (!mine?.snapshotSha) return { syncable: false, files: [] };
      const anchorTree = (await git(realRoot, ["rev-parse", "--verify", "--quiet", `${mine.snapshotSha}^{tree}`])).stdout.trim();
      const wtTree = await worktreeTreeSha(ref, realRoot);
      if (!anchorTree || !wtTree || anchorTree === wtTree) return { syncable: false, files: [] };
      const files = await touchedFiles(realRoot, anchorTree, wtTree);
      return { syncable: files.length > 0, files };
    },

    async cleanupSnapshot(input: { repoRoot: string; workerId: string }): Promise<void> {
      const realRoot = realpathOr(input.repoRoot);
      const tries = loadTries(realRoot);
      const idx = tries.findIndex((t) => t.workerId === input.workerId);
      const mine = idx >= 0 ? tries[idx]! : null;
      // A provisional layer survives worker deletion so the human can still
      // Keep/Discard it from the deck — leave its ref pinned and state intact.
      if (mine && !mine.kept) return;
      // A kept layer is already accepted into the checkout; the worktree is gone
      // so finalize it — drop the layer (its edits remain the user's own) and
      // its patch, then delete the ref below.
      if (mine && mine.kept) {
        tries.splice(idx, 1);
        saveTries(realRoot, tries);
        try { rmSync(patchPathFor(realRoot, input.workerId), { force: true }); } catch {}
      }
      await git(realRoot, ["update-ref", "-d", snapshotRef(input.workerId)]);
    },
  };
}
