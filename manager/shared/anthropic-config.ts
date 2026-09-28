// Field-merge Claude credentials into ~/.eos/config.json's `anthropic` key — the
// one writer shared by the Settings route and the Sign in with Claude flow. Merges
// into the on-disk file (not the frozen in-memory config) so hand-edits survive; a
// blank field means "clear it" and is dropped so config.json stays clean. The
// caller reloads the config afterwards.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnthropicConfig } from "../../contracts/src/anthropic.ts";

export const isCredentialSet = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function patchAnthropicConfig(home: string, patch: Partial<AnthropicConfig>): void {
  const path = join(home, "config.json");
  const existing = readConfigJson(path);
  const anthropic = existing.anthropic && typeof existing.anthropic === "object"
    ? (existing.anthropic as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...anthropic, ...patch };
  for (const k of ["apiKey", "authToken"] as const) {
    if (!isCredentialSet(merged[k])) delete merged[k];
  }
  existing.anthropic = merged;
  writeFileSync(path, JSON.stringify(existing, null, 2));
}

function readConfigJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
