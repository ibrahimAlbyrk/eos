// Backend selection for a new spawn: the SqlBackedBackendResolver decision plus
// the subscription-credential safety net. An explicit provider pick is resolved
// straight from its descriptor; a subscription in-process provider (claude-sdk)
// with NO usable subscription credential falls back to the data-derived PTY
// provider rather than spawning a broken session or silently billing a metered
// API — PTY is the sanctioned subscription path and uses the interactive login.

import type { Container } from "../container.ts";
import type { ResolvedBackend } from "../../core/src/ports/BackendDefaults.ts";
import type { BackendKind } from "../../contracts/src/canonical.ts";
import type { AgentBackend } from "../../core/src/ports/AgentBackend.ts";
import type { ResolveBackendInput } from "../../core/src/services/SqlBackedBackendResolver.ts";
import { meteredNeedsBilledIntent } from "../../core/src/domain/backend-billing.ts";

export async function resolveSpawnBackend(c: Container, input: ResolveBackendInput): Promise<ResolvedBackend> {
  // Explicit provider pick from the UI: resolve straight from the descriptor —
  // kind + the billing-derived cost mode (the route applies body.model for
  // request-model providers). An unregistered kind falls through to the
  // resolver's profile/inherit/role/global chain. An explicit PROFILE pick
  // skips this bare-kind branch entirely so it resolves through the profile
  // tier (carrying its costMode/model/auth) — a bare kind would lose those.
  let rb: ResolvedBackend;
  if (!input.explicitProfileName && input.explicitKind && c.backends.has(input.explicitKind)) {
    const d = c.backends.get(input.explicitKind).descriptor;
    // Don't fabricate a "billed" opt-in for a bare metered kind pick — leave
    // costMode unset so spawnBackendError rejects it (the opt-in must come from a
    // costMode:"billed" profile). Subscription picks are exempt.
    rb = { kind: d.kind as BackendKind, model: "opus", profileName: null, ...(d.billing === "subscription" ? { costMode: "included" as const } : {}) };
  } else {
    rb = c.backendResolver.resolveForNewWorker(input);
  }

  // Operator model OVERRIDE on a profile lane: when the picker supplies BOTH a
  // profile and a model, keep the profile's kind/baseUrl/auth/capabilities/costMode
  // but run the chosen model (e.g. the deepseek profile on deepseek-reasoner). The
  // profile's pinned model stays the default when no model is chosen.
  if (input.explicitProfileName && input.explicitModel && rb.profileName) {
    rb = { ...rb, model: input.explicitModel };
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

// Spawn-time backend guard shared by the worker + orchestrator routes. Returns an
// error message to reject with, or null to allow. (1) an explicit UI pick of a
// not-yet-enabled backend is refused (defense-in-depth — the picker only offers
// enabled ones); (2) a metered-API backend reached by ANY path without the
// costMode:"billed" opt-in is refused, so subscription billing is never silently
// diverted to a per-token API. Runs on the RESOLVED backend, not body.backendKind,
// so inherited/profile/default metered selections are covered too.
export function spawnBackendError(backend: AgentBackend, rb: ResolvedBackend, explicit: boolean): string | null {
  if (explicit && !backend.descriptor.enabled) {
    return `backend "${backend.kind}" is not enabled`;
  }
  if (meteredNeedsBilledIntent(backend.descriptor, rb)) {
    return `backend "${rb.kind}" is a metered API — use a subscription provider or a costMode:"billed" profile`;
  }
  return null;
}
