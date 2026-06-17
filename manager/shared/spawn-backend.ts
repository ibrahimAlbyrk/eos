// Backend selection for a new spawn: the SqlBackedBackendResolver decision plus
// the SDK-default safety net. A claude-sdk selection with NO subscription
// credential falls back to the PTY (claude-cli) lane rather than spawning a
// broken SDK worker or silently billing the metered API — PTY is the sanctioned
// subscription path and uses the interactive login.

import type { Container } from "../container.ts";
import type { ResolvedBackend } from "../../core/src/ports/BackendDefaults.ts";
import type { ResolveBackendInput } from "../../core/src/services/SqlBackedBackendResolver.ts";

export async function resolveSpawnBackend(c: Container, input: ResolveBackendInput): Promise<ResolvedBackend> {
  const rb = c.backendResolver.resolveForNewWorker(input);
  if (rb.kind === "claude-sdk") {
    const auth = await c.authResolver.resolve({ kind: "subscription" });
    if (auth.scheme === "none") {
      c.log.warn("sdk_auth_unavailable_fell_back_to_pty", { profile: rb.profileName });
      return { kind: "claude-cli", model: "opus", profileName: null, costMode: "included" };
    }
  }
  return rb;
}
