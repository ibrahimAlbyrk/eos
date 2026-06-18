// Backend selection for a new spawn: the SqlBackedBackendResolver decision plus
// the subscription-credential safety net. An explicit provider pick is resolved
// straight from its descriptor; a subscription in-process provider (claude-sdk)
// with NO usable subscription credential falls back to the data-derived PTY
// provider rather than spawning a broken session or silently billing a metered
// API — PTY is the sanctioned subscription path and uses the interactive login.

import type { Container } from "../container.ts";
import type { ResolvedBackend } from "../../core/src/ports/BackendDefaults.ts";
import type { BackendKind } from "../../contracts/src/canonical.ts";
import type { ResolveBackendInput } from "../../core/src/services/SqlBackedBackendResolver.ts";

export async function resolveSpawnBackend(c: Container, input: ResolveBackendInput): Promise<ResolvedBackend> {
  // Explicit provider pick from the UI: resolve straight from the descriptor —
  // kind + the billing-derived cost mode (the route applies body.model for
  // request-model providers). An unregistered kind falls through to the
  // resolver's profile/inherit/role/global chain.
  let rb: ResolvedBackend;
  if (input.explicitKind && c.backends.has(input.explicitKind)) {
    const d = c.backends.get(input.explicitKind).descriptor;
    rb = { kind: d.kind as BackendKind, model: "opus", profileName: null, costMode: d.billing === "subscription" ? "included" : "billed" };
  } else {
    rb = c.backendResolver.resolveForNewWorker(input);
  }

  // Credential safety net (data-driven): a subscription in-process provider needs
  // a usable subscription credential; with none, fall back to the subscription
  // out-of-process (PTY) provider derived from the descriptors, never a kind literal.
  const d = c.backends.has(rb.kind) ? c.backends.get(rb.kind).descriptor : null;
  if (d && d.auth === "subscription" && d.processModel === "in-process") {
    const auth = await c.authResolver.resolve({ kind: "subscription" });
    if (auth.scheme === "none") {
      const pty = c.backends.descriptors().find((x) => x.billing === "subscription" && x.processModel === "out-of-process");
      if (pty) {
        c.log.warn("sdk_auth_unavailable_fell_back_to_pty", { kind: rb.kind });
        return { kind: pty.kind as BackendKind, model: "opus", profileName: null, costMode: "included" };
      }
    }
  }
  return rb;
}
