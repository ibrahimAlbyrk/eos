// PolicyGatewayService — concrete implementation of the PolicyGateway port.
// Wraps the pure evaluator with the in-memory pending resolver registry and
// the TTL-auto-deny timer. Stateful (owns the resolver map), but holds no
// I/O dependencies beyond the ports it composes.

import type { Decision } from "../../../contracts/src/policy.ts";
import type { Policy } from "../domain/policy.ts";
import { evaluatePolicy } from "../domain/policy.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { PolicyGateway } from "../ports/PolicyGateway.ts";

export interface PolicyGatewayServiceDeps {
  pending: PendingRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  ids: IdGenerator;
  getPolicy(): Policy;
  /** Optional metrics hook called once per decision (after rule eval, before
   * any pending wait). */
  onDecision?(behavior: "allow" | "deny" | "ask"): void;
}

export class PolicyGatewayService implements PolicyGateway {
  private resolvers = new Map<string, (d: Decision) => void>();
  private readonly deps: PolicyGatewayServiceDeps;

  constructor(deps: PolicyGatewayServiceDeps) {
    this.deps = deps;
  }

  async decide(input: {
    workerId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string | null;
  }): Promise<Decision> {
    const policy = this.deps.getPolicy();
    const decision = evaluatePolicy(policy, input.toolName, input.input);
    this.deps.onDecision?.(decision.behavior);

    this.deps.events.append(input.workerId, this.deps.clock.now(), "policy", {
      tool: input.toolName,
      decision: decision.behavior,
    });
    this.deps.bus.publish("policy:decision", {
      workerId: input.workerId,
      tool: input.toolName,
      behavior: decision.behavior,
    });

    if (decision.behavior !== "ask") return decision;

    const id = this.deps.ids.newPendingId();
    const now = this.deps.clock.now();
    const expiresAt = now + policy.ttlMs;
    this.deps.pending.insert({
      id,
      workerId: input.workerId,
      toolName: input.toolName,
      input: input.input,
      toolUseId: input.toolUseId ?? null,
      createdAt: now,
      expiresAt,
    });
    this.deps.events.append(input.workerId, now, "permission_pending", { id, tool: input.toolName });
    this.deps.bus.publish("pending:created", { id, workerId: input.workerId });

    return new Promise<Decision>((resolve) => {
      this.resolvers.set(id, resolve);
      if (policy.ttlMs) {
        setTimeout(() => {
          if (!this.resolvers.has(id)) return;
          this.resolvers.delete(id);
          this.deps.pending.resolve({
            id, decision: "deny", reason: "TTL exceeded", updatedInput: null,
          });
          this.deps.events.append(input.workerId, this.deps.clock.now(), "permission_ttl_deny", { id });
          this.deps.bus.publish("pending:ttl_expired", { id, workerId: input.workerId });
          resolve({ behavior: "deny", message: "human approval timed out" });
        }, policy.ttlMs);
      }
    });
  }

  resolvePending(input: { id: string; decision: Decision }): boolean {
    const dec = input.decision;
    const updatedInput =
      dec.behavior === "allow" ? (dec.updatedInput ?? null) : null;
    const reason = dec.behavior === "deny" ? dec.message : null;
    const applied = this.deps.pending.resolve({
      id: input.id,
      decision: dec.behavior === "allow" ? "allow" : "deny",
      reason,
      updatedInput,
    });
    const resolver = this.resolvers.get(input.id);
    if (resolver) {
      this.resolvers.delete(input.id);
      resolver(dec);
    }
    if (applied) {
      this.deps.bus.publish("pending:resolved", { id: input.id, behavior: dec.behavior });
    }
    return applied;
  }
}
