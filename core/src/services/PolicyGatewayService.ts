// PolicyGatewayService — concrete implementation of the PolicyGateway port.
// Decision chain (Chain of Responsibility):
//   0. Subagent caller scope — Eos control tools (domain/tool-scope.ts) are
//      main-agent only; calls carrying agent_id are denied outright
//   0.5 Worker-type tool scope (capability boundary) → deny OR pass-through
//      (above policy.yaml so a broad rule can't re-grant a type-denied tool)
//   1. Explicit policy.yaml rule match → use that decision
//   2. Per-worker permission mode → MODE_SPECS verdict by tool category
//   3. policy.default → final fallback
//
// Stateful (owns the pending-permission resolver map), but holds no I/O
// dependencies beyond the ports it composes.

import type { Decision } from "../../../contracts/src/policy.ts";
import type { Policy } from "../domain/policy.ts";
import { ruleMatches, evaluatePolicy } from "../domain/policy.ts";
import { MODE_SPECS, classifyTool } from "../domain/permission-mode.ts";
import { isEosControlTool, isBlockedBuiltinTool, BLOCKED_BUILTIN_TOOL_MESSAGE } from "../domain/tool-scope.ts";
import { matchesAny } from "../domain/tool-glob.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { PolicyGateway } from "../ports/PolicyGateway.ts";
import type { PermissionModeResolver } from "../ports/PermissionModeResolver.ts";
import type { WorkerToolScopeResolver } from "../ports/WorkerToolScopeResolver.ts";

export interface PolicyGatewayServiceDeps {
  pending: PendingRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  ids: IdGenerator;
  modeResolver: PermissionModeResolver;
  /** Per-worker materialized tool scope (worker type allow/deny + editRegex).
   * The capability-boundary rung — deny-or-passthrough, above policy.yaml,
   * never short-circuits allow. Absent ⇒ untyped, rung skipped. */
  toolScopeResolver?: WorkerToolScopeResolver;
  /** Absolute path of the Claude plans dir (~/.claude/plans). When set,
   * fileEdits targeting it classify as planFile (allowed in every mode). */
  plansDir?: string;
  getPolicy(): Policy;
  /** Optional metrics hook called once per decision (after rule eval, before
   * any pending wait). */
  onDecision?(behavior: "allow" | "deny" | "ask"): void;
}

export class PolicyGatewayService implements PolicyGateway {
  private resolvers = new Map<string, { resolve: (d: Decision) => void; workerId: string }>();
  private readonly deps: PolicyGatewayServiceDeps;

  constructor(deps: PolicyGatewayServiceDeps) {
    this.deps = deps;
    // A worker dying (killed or naturally exited) strands any of its parked
    // `ask` resolvers + Map entries. KillWorker already deletes the pending
    // rows before publishing, so we track workerId per resolver rather than
    // querying PendingRepo. Both events also drive a periodic expiry sweep so
    // stale pendings don't survive past startup.
    deps.bus.subscribe("worker:removed", (msg) => this.onWorkerGone(msg.payload));
    deps.bus.subscribe("worker:exit", (msg) => this.onWorkerGone(msg.payload));
  }

  private onWorkerGone(payload: unknown): void {
    const workerId = (payload as { workerId?: unknown })?.workerId;
    if (typeof workerId === "string") this.rejectWorkerResolvers(workerId);
    this.deps.pending.sweepExpired(this.deps.clock.now(), "expired (swept on worker exit)");
  }

  private rejectWorkerResolvers(workerId: string): void {
    for (const [id, entry] of this.resolvers) {
      if (entry.workerId !== workerId) continue;
      this.resolvers.delete(id);
      entry.resolve({ behavior: "deny", message: "worker exited before permission was resolved" });
    }
  }

  async decide(input: {
    workerId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string | null;
    agentId?: string | null;
  }): Promise<Decision> {
    const policy = this.deps.getPolicy();
    const decision = this.evaluate(policy, input.workerId, input.toolName, input.input, input.agentId ?? null);
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
      this.resolvers.set(id, { resolve, workerId: input.workerId });
    });
  }

  // Chain of responsibility: rule match → mode verdict → policy.default.
  // Returns the first decision that fires. Rule matching + default fallback
  // are delegated to domain/evaluatePolicy; only the mode-verdict step (which
  // sits between "no rule matched" and the default fallback) lives here.
  private evaluate(
    policy: Policy,
    workerId: string,
    toolName: string,
    input: Record<string, unknown>,
    agentId: string | null,
  ): Decision {
    // Structural invariants ahead of user rules — a policy.yaml allow or a
    // permissive mode (bypassPermissions) must not override them.
    if (isBlockedBuiltinTool(toolName)) {
      return { behavior: "deny", message: BLOCKED_BUILTIN_TOOL_MESSAGE };
    }
    // A subagent may not drive the control plane. Absent agent_id (main loop)
    // falls through unchanged.
    if (agentId && isEosControlTool(toolName)) {
      return {
        behavior: "deny",
        message: `${toolName} is main-agent only — subagents cannot use Eos control tools. Return your findings; the main agent acts on them.`,
      };
    }
    // Worker-type tool scope (capability boundary) — sits above policy.yaml so a
    // stale/broad allow can't re-grant a tool the type denies. DENY-OR-PASSTHROUGH:
    // it may deny, but never short-circuits allow (that would collapse the mode
    // verdict layer). Empty allow ⇒ inherit-all; deny always subtracts.
    const scope = this.deps.toolScopeResolver?.resolveFor(workerId);
    if (scope) {
      // Command-scoped patterns ("Bash(git push:*)") match against the tool's
      // command argument; name globs ignore it. For Bash-family tools that
      // argument is the command string.
      const arg = typeof input.command === "string" ? input.command : undefined;
      if (matchesAny(toolName, scope.deny, arg)) {
        return { behavior: "deny", message: `${toolName} is denied by this worker's type` };
      }
      if (scope.allow.length > 0 && !matchesAny(toolName, scope.allow, arg)) {
        return { behavior: "deny", message: `${toolName} is not in this worker type's allowed tools` };
      }
      // editRegex confines file edits to matching paths. Only fileEdits are
      // gated (a planFile / non-edit tool is untouched). An invalid regex is
      // ignored (compileEditRegex → null) rather than bricking every edit.
      if (scope.editRegex) {
        const re = compileEditRegex(scope.editRegex);
        if (re && classifyTool(toolName, input, this.deps.plansDir) === "fileEdit") {
          const target = input.file_path ?? input.notebook_path;
          if (typeof target !== "string" || !re.test(target)) {
            return { behavior: "deny", message: `edit target is outside this worker type's allowed paths` };
          }
        }
      }
      // otherwise fall through to policy.yaml / mode verdict (NOT an allow).
    }
    if (policy.rules.some((rule) => ruleMatches(rule, toolName, input))) {
      return evaluatePolicy(policy, toolName, input);
    }

    const mode = this.deps.modeResolver.resolveFor(workerId);
    const category = classifyTool(toolName, input, this.deps.plansDir);
    const verdict = MODE_SPECS[mode].decide(category);
    if (verdict === "allow") return { behavior: "allow", updatedInput: input };
    if (verdict === "deny") {
      return { behavior: "deny", message: `denied by permission mode: ${mode}` };
    }

    return evaluatePolicy(policy, toolName, input);
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
    const entry = this.resolvers.get(input.id);
    if (entry) {
      this.resolvers.delete(input.id);
      entry.resolve(dec);
    }
    if (applied) {
      this.deps.bus.publish("pending:resolved", { id: input.id, behavior: dec.behavior });
    }
    return applied;
  }
}

// Compile a worker-type editRegex once per call. An invalid pattern returns null
// → the editRegex check is skipped (allow/deny still apply) rather than denying
// every edit on a typo.
function compileEditRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
