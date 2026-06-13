// ChildProcessConflictResolution — persists one resolved conflict via fs +
// the `git` binary, always with `-C <cwd>`. Mirrors ChildProcessBranchPush as a
// focused write adapter. The decision of WHAT to write is pure domain
// (core/domain/conflict.ts); this only writes + stages.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConflictResolution } from "../../../core/src/ports/ConflictResolution.ts";
import type { ConflictKind } from "../../../contracts/src/http.ts";

const exec = promisify(execFile);

// (kind, side) → stage the file ("add") or its removal ("rm"). For the
// keep-side the working tree already holds that version, so `add` stages it;
// the drop-side stages a deletion. See ConflictResolution doc for the table.
function actionFor(kind: ConflictKind, side: "ours" | "theirs"): "add" | "rm" {
  switch (kind) {
    case "theirs-deleted": return side === "ours" ? "add" : "rm";
    case "ours-deleted":   return side === "ours" ? "rm" : "add";
    case "ours-added":     return side === "ours" ? "add" : "rm";
    case "theirs-added":   return side === "ours" ? "rm" : "add";
    case "both-deleted":   return "rm";
    default:               return "add"; // `content` never reaches takeSide
  }
}

export const childProcessConflictResolution: ConflictResolution = {
  async writeResolved(cwd: string, path: string, content: string): Promise<void> {
    await writeFile(join(cwd, path), content);
    await exec("git", ["-C", cwd, "add", "--", path]);
  },

  async takeSide(cwd: string, path: string, side: "ours" | "theirs", kind: ConflictKind): Promise<void> {
    if (actionFor(kind, side) === "rm") {
      // -f: the path is unmerged / locally modified; force the staged deletion.
      await exec("git", ["-C", cwd, "rm", "-f", "--", path]);
    } else {
      await exec("git", ["-C", cwd, "add", "--", path]);
    }
  },
};
