// The credential store dirs of plan sign-ins, under ~/.eos/accounts: one
// <cli>-<loginId> dir per sign-in (a provider's sign-in from before it could hold
// several keeps its plain <cli> dir). Only dirs this adapter created are ever
// removed; a signed-out store goes to accounts/.trash.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PlanLoginDirs } from "../../../core/src/ports/PlanLoginStore.ts";

// The CLI each provider signs in through names its store dirs.
const CLI_DIR: Record<string, string> = { anthropic: "claude", openai: "codex", gemini: "gemini" };

export function createPlanLoginDirs(accountsDir: string): PlanLoginDirs {
  const ours = (storeDir: string): boolean =>
    dirname(storeDir) === accountsDir && Object.values(CLI_DIR).some((cli) => basename(storeDir).startsWith(`${cli}-`));

  return {
    create(provider, id) {
      const dir = join(accountsDir, `${CLI_DIR[provider] ?? provider}-${id}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    discard(storeDir) {
      if (ours(storeDir)) rmSync(storeDir, { recursive: true, force: true });
    },
    trash(storeDir) {
      if (dirname(storeDir) !== accountsDir || !existsSync(storeDir)) return;
      const trash = join(accountsDir, ".trash");
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      renameSync(storeDir, join(trash, `${basename(storeDir)}.${stamp}`));
    },
  };
}
