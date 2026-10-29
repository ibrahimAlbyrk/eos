// Brings one release onto this disk, ready to swap in: read its manifest, see
// what the installed bundle already holds, fetch only the missing chunks, build
// the new bundle beside the old one and have the platform vouch for it.
// Ranges already fetched are kept, so a cancelled or failed run resumes.

import type { UpdateManifest, UpdatePointer } from "../../../../contracts/src/update.ts";
import { UpdateError } from "../../domain/update/errors.ts";
import { manifestProblem } from "../../domain/update/manifest.ts";
import { planUpdate, type FetchRange } from "../../domain/update/plan.ts";
import type { AppBundleCheck, BundleIndexer, StagedUpdate, UpdateFeed, UpdateWorkspace } from "../../ports/Updates.ts";

const PARALLEL_RANGES = 4;
const NOTES_MAX_BYTES = 64 * 1024;

export interface DownloadUpdateDeps {
  readonly feed: UpdateFeed;
  readonly indexer: BundleIndexer;
  readonly workspace: UpdateWorkspace;
  readonly bundleCheck: AppBundleCheck;
}

export interface DownloadUpdateInput {
  readonly pointer: UpdatePointer;
  readonly installedRoot: string;
  // Called once the plan is known (done = 0), then after every range.
  readonly onProgress: (done: number, total: number) => void;
  // Called once every byte is in, before staging.
  readonly onStaging?: () => void;
}

export async function downloadUpdate(deps: DownloadUpdateDeps, input: DownloadUpdateInput, signal: AbortSignal): Promise<StagedUpdate> {
  const { pointer } = input;
  await deps.workspace.clear(pointer.version);

  const manifest = await deps.feed.manifest(pointer.manifest);
  if (manifest.version !== pointer.version || manifest.platform !== pointer.platform) {
    throw new UpdateError("bad-release", "the manifest is not the release its pointer names");
  }
  const problem = manifestProblem(manifest);
  if (problem) throw new UpdateError("bad-release", problem);

  const plan = planUpdate(await deps.indexer.index(input.installedRoot), manifest);
  let done = 0;
  input.onProgress(0, plan.downloadBytes);
  await forEachLimit(plan.ranges, PARALLEL_RANGES, signal, async (range, inner) => {
    if (!(await deps.workspace.hasRange(pointer.version, range))) await fetchRange(deps, manifest, range, inner);
    done += range.length;
    input.onProgress(done, plan.downloadBytes);
  });

  input.onStaging?.();
  const path = await deps.workspace.stage({ version: pointer.version, manifest, plan, installedRoot: input.installedRoot });
  signal.throwIfAborted();
  await deps.bundleCheck.verify(path, input.installedRoot);
  const notes = pointer.notes ? await deps.feed.text(pointer.notes, NOTES_MAX_BYTES).catch(() => null) : null;
  const full = manifest.chunks.reduce((n, c) => n + c.zsize, 0);
  const staged: StagedUpdate = { version: pointer.version, path, bytes: plan.downloadBytes, full, notes };
  await deps.workspace.markStaged(staged);
  return staged;
}

// Bytes whose chunks don't match are fetched once more before giving up.
async function fetchRange(deps: DownloadUpdateDeps, manifest: UpdateManifest, range: FetchRange, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const bytes = await deps.feed.range(manifest.packs[range.pack], range.offset, range.length, signal);
    try {
      await deps.workspace.putRange(manifest.version, range, bytes, manifest);
      return;
    } catch (e) {
      if (attempt >= 1 || !(e instanceof UpdateError && e.code === "corrupt")) throw e;
    }
  }
}

// One failing range stops its siblings too.
async function forEachLimit<T>(
  items: readonly T[], limit: number, signal: AbortSignal, fn: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const inner = new AbortController();
  const forward = (): void => inner.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      inner.signal.throwIfAborted();
      await fn(items[next++], inner.signal);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker().catch((e: unknown) => {
      inner.abort(e);
      throw e;
    })));
  } finally {
    signal.removeEventListener("abort", forward);
  }
}
