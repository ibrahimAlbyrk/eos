// Moves one transfer's bytes from a source endpoint to a destination endpoint:
// scan the picked items, stage them at the destination, copy every file in
// chunks, then commit them into place. Resumable by construction — every write
// says the offset it expects, and the destination reports what it already holds,
// so a dropped link, a pause or a restart only costs the chunk in flight.
// Pause and cancel abort the signal; whether the staging stays is the caller's call.

import type {
  ManifestItem, TransferCommitResult, TransferConflict, TransferDecision, TransferManifest, TransferRoute,
} from "../../../contracts/src/transfer.ts";
import type { Clock } from "../ports/Clock.ts";
import type { TransferEndpoint } from "../ports/TransferEndpoint.ts";
import {
  RateMeter, TransferError, baseName, chunkLength, conflictsOf, fileConcurrency, isTransient, joinPath, parentDir,
} from "../domain/transfer.ts";

// How long the link may stay down before a run gives up (and can be resumed).
const DEFAULT_OUTAGE_MS = 120_000;

export interface RunTransferEvents {
  scanned(manifest: TransferManifest): void;
  prepared(p: { conflicts: TransferConflict[]; doneBytes: number }): void;
  progress(doneBytes: number, rate: number): void;
  // Resolves once every conflict has a decision — at once when they were preset.
  // Bytes keep flowing meanwhile; only the commit waits.
  decisions(conflicts: TransferConflict[]): Promise<Record<string, TransferDecision>>;
  // Every byte is staged; what's left is the commit (and any decision it waits on).
  copied(): void;
  committing(): void;
}

export interface RunTransferDeps {
  readonly source: TransferEndpoint;
  readonly dest: TransferEndpoint;
  readonly clock: Clock;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  // The link's current path — chunk size and concurrency follow it.
  readonly route: () => TransferRoute | null;
  readonly events: RunTransferEvents;
  readonly outageMs?: number;
}

export interface RunTransferInput {
  readonly id: string;
  readonly sources: readonly string[];
  readonly destDir: string;
}

export async function runTransfer(deps: RunTransferDeps, input: RunTransferInput, signal: AbortSignal): Promise<TransferCommitResult> {
  // One failing file stops its siblings too, not just the caller.
  const inner = new AbortController();
  const forward = (): void => inner.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  try {
    return await run(deps, input, inner);
  } finally {
    signal.removeEventListener("abort", forward);
  }
}

async function run(deps: RunTransferDeps, input: RunTransferInput, ctl: AbortController): Promise<TransferCommitResult> {
  const signal = ctl.signal;
  const retry = makeRetry(deps, signal);
  const { id, destDir } = input;

  const manifest = await retry(() => deps.source.scan(input.sources));
  deps.events.scanned(manifest);
  const prep = await retry(() => deps.dest.prepare({ id, destDir, items: manifest.items }));
  const conflicts = conflictsOf(manifest.roots, prep.existing);

  const sourceDirs = new Map(input.sources.map((p) => [baseName(p), parentDir(p)]));
  const sourcePath = (rel: string): string => joinPath(sourceDirs.get(rel.split("/", 1)[0]!) ?? "/", rel);
  const staged = (f: ManifestItem): number => Math.min(prep.staged[f.rel] ?? 0, f.size);

  const files = manifest.items.filter((f) => f.type === "file" && f.size > 0);
  let done = files.reduce((n, f) => n + staged(f), 0);
  deps.events.prepared({ conflicts, doneBytes: done });
  const decided = conflicts.length ? deps.events.decisions(conflicts) : Promise.resolve({});
  decided.catch(() => {});

  const meter = new RateMeter(() => deps.clock.now());
  const queue = files.filter((f) => staged(f) < f.size);

  const copyFile = async (f: ManifestItem): Promise<void> => {
    const path = sourcePath(f.rel);
    const expect = { size: f.size, mtimeMs: f.mtimeMs };
    const readAt = (at: number): Promise<Uint8Array> => {
      const length = Math.min(chunkLength(deps.route(), meter.rate()), f.size - at);
      const p = retry(() => deps.source.read(path, { offset: at, length }, expect));
      // A prefetch dropped after an offset correction must not surface as unhandled.
      p.catch(() => {});
      return p;
    };
    let offset = staged(f);
    let next: Promise<Uint8Array> | null = readAt(offset);
    while (offset < f.size && next) {
      const chunk = await next;
      if (chunk.byteLength === 0) throw new TransferError("source-changed", `${f.rel} got shorter while it was being copied`);
      const end = offset + chunk.byteLength;
      // The next read runs while this chunk is written.
      next = end < f.size ? readAt(end) : null;
      let size: number;
      try {
        size = await retry(() => deps.dest.write({ id, destDir, rel: f.rel, offset }, chunk));
      } catch (e) {
        // A retried write that had landed, or a restart: carry on from what's there.
        if (!(e instanceof TransferError) || e.code !== "offset-mismatch" || e.have === undefined || e.have > f.size) throw e;
        done += e.have - offset;
        offset = e.have;
        next = offset < f.size ? readAt(offset) : null;
        continue;
      }
      done += size - offset;
      offset = size;
      meter.add(chunk.byteLength);
      deps.events.progress(done, meter.rate());
    }
  };

  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      signal.throwIfAborted();
      await copyFile(f);
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(fileConcurrency(deps.route()), queue.length)) }, () =>
      worker().catch((e: unknown) => { ctl.abort(e); throw e; })),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw signal.aborted ? signal.reason : failed.reason;

  deps.events.copied();
  const decisions = await untilAborted(decided, signal);
  deps.events.committing();
  return retry(() => deps.dest.commit({ id, destDir, decisions }));
}

function makeRetry(deps: RunTransferDeps, signal: AbortSignal): <T>(op: () => Promise<T>) => Promise<T> {
  let downSince: number | null = null;
  return async <T>(op: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const v = await op();
        downSince = null;
        return v;
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        if (!isTransient(e)) throw e;
        const now = deps.clock.now();
        downSince ??= now;
        if (now - downSince > (deps.outageMs ?? DEFAULT_OUTAGE_MS)) throw e;
        await deps.sleep(Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)), signal);
      }
    }
  };
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}
