// FactProvider — contributes runtime facts at session start (Layer 2). Adapters
// read the world (git, environment) and return the facts they can determine;
// the assembler merges them over a base derived from the spawn context. A
// provider that can't determine a fact omits it (fail-safe: the conservative
// base value stands), never throws.

import type { SessionFacts } from "../../../contracts/src/prompt.ts";

// What the daemon already knows about a spawn — the seed the assembler turns
// into the base FactSet before providers run.
export interface SessionSpawnContext {
  role: "orchestrator" | "worker" | "git";
  parentId: string | null;
  name: string;
  workerId: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
  cwd: string | null;
  worktreeDir: string | null;
  branch: string | null;
  repoRoot: string | null;
  isAttached: boolean;
  hasMcp: boolean;
}

export interface FactProvider {
  gather(ctx: SessionSpawnContext): Partial<SessionFacts> | Promise<Partial<SessionFacts>>;
}
