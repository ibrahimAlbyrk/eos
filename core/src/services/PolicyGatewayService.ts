// PolicyGatewayService — concrete implementation of the PolicyGateway port.
// Decision chain (Chain of Responsibility):
//   1. Explicit policy.yaml rule match → use that decision
//   2. Per-worker permission mode → MODE_SPECS verdict by tool category
//   3. policy.default → final fallback
//
// Stateful (owns the pending-permission resolver map), but holds no I/O
// dependencies beyond the ports it composes.

import type { Decision } from "../../../contracts/src/policy.ts";
import type { Policy, CompiledRule } from "../domain/policy.ts";
import { ruleMatches } from "../domain/policy.ts";
import { MODE_SPECS, classifyTool } from "../domain/permission-mode.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { PolicyGateway } from "../ports/PolicyGateway.ts";
import type { PermissionModeResolver } from "../ports/PermissionModeResolver.ts";

export interface PolicyGatewayServiceDeps {
  pending: PendingRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  ids: IdGenerator;
  modeResolver: PermissionModeResolver;
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
    const decision = this.evaluate(policy, input.workerId, input.toolName, input.input);
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
    const expiresAt = policy.ttlMs ? now + policy.ttlMs : now + 86_400_000;
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
    });
  }

  // Chain of responsibility: rule match → mode verdict → policy.default.
  // Returns the first decision that fires.
  private evaluate(
    policy: Policy,
    workerId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Decision {
    const matched = findMatchingRule(policy.rules, toolName, input);
    if (matched) return applyRule(matched, input);

    const mode = this.deps.modeResolver.resolveFor(workerId);
    const category = classifyTool(toolName);
    const verdict = MODE_SPECS[mode].decide(category);
    if (verdict === "allow") return { behavior: "allow", updatedInput: input };
    if (verdict === "deny") {
      return { behavior: "deny", message: `denied by permission mode: ${mode}` };
    }

    if (policy.default === "allow") return { behavior: "allow", updatedInput: input };
    if (policy.default === "deny") return { behavior: "deny", message: "no rule matched (default deny)" };
    return { behavior: "ask" };
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

function findMatchingRule(
  rules: readonly CompiledRule[],
  toolName: string,
  input: Record<string, unknown>,
): CompiledRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, toolName, input)) return rule;
  }
  return null;
}

function applyRule(rule: CompiledRule, input: Record<string, unknown>): Decision {
  const raw = rule.raw;
  if (raw.action === "allow") return { behavior: "allow", updatedInput: input };
  if (raw.action === "deny") return { behavior: "deny", message: raw.reason ?? "denied by policy" };
  if (raw.action === "ask") return { behavior: "ask" };
  if (raw.action === "rewrite" && rule.rewriteRe && raw.rewriteTo) {
    const field = raw.rewriteField ?? "command";
    const next = String(input[field] ?? "").replace(rule.rewriteRe, raw.rewriteTo);
    return { behavior: "allow", updatedInput: { ...input, [field]: next } };
  }
  return { behavior: "ask" };
}
