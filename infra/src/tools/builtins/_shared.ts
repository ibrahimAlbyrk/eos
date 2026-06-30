// Shared helpers for the bare-named built-in tools. Path resolution is cwd-scoped:
// a relative file_path resolves against the worker's cwd (the BuiltinToolContext),
// an absolute one is honored as-is — matching the bundled binary's behavior.

import { isAbsolute, resolve } from "node:path";
import type { BuiltinToolContext } from "../../../../core/src/ports/BuiltinToolRegistry.ts";

export function resolveToolPath(ctx: BuiltinToolContext, p: unknown): string {
  if (typeof p !== "string" || p.length === 0) throw new Error("a file path is required");
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  if (typeof v !== "string") throw new Error(`'${field}' is required and must be a string`);
  return v;
}

export function optionalNumber(input: Record<string, unknown>, field: string): number | undefined {
  const v = input[field];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Shared string-replace semantics for Edit + MultiEdit: old_string must be unique
// (unless replace_all), present, and distinct from new_string — matching the
// bundled binary so an edit fails loudly instead of silently rewriting the wrong
// occurrence.
export function applyStringEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === "") throw new Error("'old_string' must not be empty");
  if (oldString === newString) throw new Error("'old_string' and 'new_string' must be different");
  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) throw new Error("'old_string' was not found in the file");
  if (!replaceAll && occurrences > 1) {
    throw new Error(`'old_string' is not unique (${occurrences} matches) — add surrounding context or set replace_all:true`);
  }
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
}
