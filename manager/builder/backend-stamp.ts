// The one function both the daemon (at boot, to self-stamp /health) and the
// CLI (to decide whether a restart is needed) call. Keeping it shared is what
// makes "running daemon == current source" provable instead of guessed.

import { computeStamp } from "./hash.ts";
import { backendSpec } from "./inputs.ts";

export function computeBackendStamp(repoRoot: string, configJsonPath: string): string {
  return computeStamp(backendSpec(repoRoot, configJsonPath));
}
