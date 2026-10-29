// What the update use-cases need from the outside world: the feed on the
// network, the key that signs it, the installed bundle on disk, a workspace for
// fetched bytes and the staged copy, and the platform's own check of an app.
// Errors are UpdateError (domain/update/errors.ts).

import type {
  SignedUpdatePointer, UpdateManifest, UpdatePlatform, UpdatePointer,
} from "../../../contracts/src/update.ts";
import type { BundleIndex, FetchRange, UpdatePlan } from "../domain/update/plan.ts";

export interface UpdateFeed {
  // null while the feed has no release for this platform.
  pointer(platform: UpdatePlatform): Promise<SignedUpdatePointer | null>;
  // Fetched, checked against the pointer's hash and size, unpacked, parsed.
  manifest(ref: UpdatePointer["manifest"]): Promise<UpdateManifest>;
  range(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  text(path: string, maxBytes: number): Promise<string>;
}

export interface UpdateSignature {
  verify(payload: string, signature: string): boolean;
}

export interface BundleIndexer {
  index(root: string): Promise<BundleIndex>;
}

export interface StagedUpdate {
  version: string;
  // The staged bundle, ready to take the installed one's place.
  path: string;
  // What this update downloaded, and what the whole release would have.
  bytes: number;
  full: number;
  notes: string | null;
}

export interface UpdateWorkspace {
  hasRange(version: string, range: FetchRange): Promise<boolean>;
  // Refuses bytes whose chunks don't match their ids.
  putRange(version: string, range: FetchRange, bytes: Uint8Array, manifest: UpdateManifest): Promise<void>;
  // Builds the new bundle next to the installed one and checks every entry
  // against the manifest; returns the staged bundle's path.
  stage(input: { version: string; manifest: UpdateManifest; plan: UpdatePlan; installedRoot: string }): Promise<string>;
  staged(): Promise<StagedUpdate | null>;
  markStaged(update: StagedUpdate): Promise<void>;
  // Drops fetched bytes of every version but `keep`, and any staged copy. The
  // previous app the applier set aside stays: it may still be needed to roll back.
  clear(keep?: string): Promise<void>;
}

export interface AppBundleCheck {
  // The staged copy is signed by the same developer as the installed app and
  // the platform would run it; throws UpdateError when not.
  verify(staged: string, installed: string): Promise<void>;
}
