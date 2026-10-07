// One Mac's disk as a file transfer sees it. The engine holds two: this Mac's
// (in-process) and a paired host's (over the link). Errors are TransferError.

import type {
  TransferCommitRequest, TransferCommitResult, TransferListing, TransferManifest,
  TransferPrepareRequest, TransferPrepareResult,
} from "../../../contracts/src/transfer.ts";

export interface TransferEndpoint {
  list(dir: string, opts?: { hidden?: boolean }): Promise<TransferListing>;
  // Everything under the picked paths, without following symlinks.
  scan(paths: readonly string[]): Promise<TransferManifest>;
  // `expect` is the file as scanned — a file that changed since is refused.
  read(path: string, range: { offset: number; length: number }, expect: { size: number; mtimeMs: number }): Promise<Uint8Array>;
  // Staging + what already sits where the items would land.
  prepare(req: TransferPrepareRequest): Promise<TransferPrepareResult>;
  // Appends at `offset` (must equal the staged size); returns the new size.
  write(at: { id: string; destDir: string; rel: string; offset: number }, data: Uint8Array): Promise<number>;
  commit(req: TransferCommitRequest): Promise<TransferCommitResult>;
  abort(req: { id: string; destDir: string }): Promise<void>;
  // The git project a folder belongs to, as a key that means the same repo on any Mac.
  projectKey(dir: string): Promise<string | null>;
  // This Mac's folder for such a key, if it has a checkout of that repo.
  locate(key: string): Promise<string | null>;
  home(): Promise<string>;
}
