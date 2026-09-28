// Where the Codex CLI lives: the `codex` on PATH, else the copy the ChatGPT or
// Codex desktop app ships. EOS_CODEX_BIN overrides.

import { resolveCliBinary } from "../cliBinary.ts";

const APP_BUNDLES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export function resolveCodexBinary(env: Record<string, string | undefined> = process.env): string | null {
  return resolveCliBinary({ name: "codex", overrideVar: "EOS_CODEX_BIN", bundles: APP_BUNDLES }, env);
}
