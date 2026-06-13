// ConflictResolution — narrow write port for resolving merge conflicts. Kept
// separate from the read-only GitInfo port (ISP), and mirrors BranchPush: the
// decision of WHAT to write is pure domain (conflict.ts assembleResolution);
// this port only persists one already-decided resolution and stages it.

import type { ConflictKind } from "../../../contracts/src/http.ts";

export interface ConflictResolution {
  /** Write the fully-assembled content for a `content` conflict, then stage it
   *  (`git add`). The file leaves the unmerged set. Never throws on a clean
   *  resolution; surfaces I/O errors to the caller. */
  writeResolved(cwd: string, path: string, content: string): Promise<void>;
  /** Resolve an add/delete conflict (no in-file markers) by keeping or removing
   *  the file per (kind, side), then staging the outcome:
   *    theirs-deleted (UD): ours→keep (add), theirs→accept deletion (rm)
   *    ours-deleted   (DU): ours→keep deletion (rm), theirs→restore (add)
   *    ours-added     (AU): ours→keep (add), theirs→drop (rm)
   *    theirs-added   (UA): ours→drop (rm), theirs→keep (add)
   *    both-deleted   (DD): either side → rm */
  takeSide(cwd: string, path: string, side: "ours" | "theirs", kind: ConflictKind): Promise<void>;
}
