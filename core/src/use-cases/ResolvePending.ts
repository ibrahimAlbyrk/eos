// ResolvePending — user-facing approve/deny entrypoint.

import type { Decision } from "../../../contracts/src/policy.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { PolicyGateway } from "../ports/PolicyGateway.ts";
import { NotFoundError, ConflictError } from "../errors/index.ts";

export interface ResolvePendingDeps {
  pending: PendingRepo;
  gateway: PolicyGateway;
}

export interface ResolvePendingCommand {
  id: string;
  decision: "allow" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export function resolvePending(
  deps: ResolvePendingDeps,
  input: ResolvePendingCommand,
): { ok: true } {
  const row = deps.pending.findById(input.id);
  if (!row) throw new NotFoundError("pending", input.id);
  if (row.resolved) throw new ConflictError(`already resolved: ${row.decision}`);

  let dec: Decision;
  if (input.decision === "allow") {
    const baseInput = JSON.parse(row.input) as Record<string, unknown>;
    dec = { behavior: "allow", updatedInput: input.updatedInput ?? baseInput };
  } else {
    dec = { behavior: "deny", message: input.reason ?? "denied by human" };
  }

  const applied = deps.gateway.resolvePending({ id: input.id, decision: dec });
  if (!applied) throw new ConflictError("expired or already resolved");
  return { ok: true };
}
