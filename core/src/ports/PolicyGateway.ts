// PolicyGateway — the entrypoint use-cases call to obtain a decision.
// Wraps the pure policy engine + the pending-permissions long-poll. The
// adapter (daemon-side) registers an in-memory resolver per pending id and
// awaits human resolution via /pending/:id/decision.

import type { Decision } from "../../../contracts/src/policy.ts";

export interface PolicyGateway {
  decide(input: {
    workerId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string | null;
  }): Promise<Decision>;
  /** Resolve a pending request from an external trigger (UI/CLI). Returns
   * true if the resolution was applied; false if the id was already
   * resolved or unknown. */
  resolvePending(input: {
    id: string;
    decision: Decision;
  }): boolean;
}
