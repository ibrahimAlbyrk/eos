// Policy engine — pure functions, no I/O. Imported by daemon.ts and exercised
// by tests in __tests__/policy.test.ts.

export type PolicyAction = "allow" | "deny" | "ask" | "rewrite";

export interface PolicyRule {
  tool?: string | string[];
  action: PolicyAction;
  reason?: string;
  rewriteField?: string;
  rewriteFrom?: string;
  rewriteTo?: string;
  [k: string]: unknown;
}

export interface CompiledRule {
  raw: PolicyRule;
  toolSet: Set<string> | null;
  fieldMatchers: Array<{ key: string; re: RegExp }>;
  rewriteRe: RegExp | null;
}

export interface Policy {
  default: PolicyAction;
  ttlMs: number;
  rules: CompiledRule[];
}

export type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  | { behavior: "ask" };

const RESERVED_RULE_KEYS = new Set([
  "tool", "action", "reason", "rewriteField", "rewriteFrom", "rewriteTo",
]);

/**
 * Compiles a raw {@link PolicyRule} into a runtime-ready {@link CompiledRule}.
 * All RegExp construction happens here (once at policy-load time) so the hot
 * permission path doesn't pay for `new RegExp` per request, and malformed
 * patterns surface immediately instead of at first match.
 *
 * Returns `null` for any rule that fails to compile — the caller is expected
 * to drop it from the active policy. The `log` callback receives a single
 * line describing why; default is a no-op for unit-test friendliness.
 */
export function compileRule(
  rule: PolicyRule,
  idx: number,
  source: string,
  log: (msg: string) => void = () => {},
): CompiledRule | null {
  let toolSet: Set<string> | null = null;
  if (rule.tool) {
    const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool];
    toolSet = new Set(tools);
  }
  const fieldMatchers: Array<{ key: string; re: RegExp }> = [];
  for (const [k, v] of Object.entries(rule)) {
    if (RESERVED_RULE_KEYS.has(k)) continue;
    try {
      fieldMatchers.push({ key: k, re: new RegExp(v as string) });
    } catch (e) {
      log(`policy rule ${idx} (${source}) has invalid regex for "${k}": ${(e as Error).message} — dropping rule`);
      return null;
    }
  }
  let rewriteRe: RegExp | null = null;
  if (rule.action === "rewrite") {
    if (!rule.rewriteFrom || !rule.rewriteTo) {
      log(`policy rule ${idx} (${source}) action=rewrite missing rewriteFrom/rewriteTo — dropping`);
      return null;
    }
    try {
      rewriteRe = new RegExp(rule.rewriteFrom);
    } catch (e) {
      log(`policy rule ${idx} (${source}) bad rewriteFrom regex: ${(e as Error).message} — dropping`);
      return null;
    }
  }
  return { raw: rule, toolSet, fieldMatchers, rewriteRe };
}

/**
 * Pure predicate — does the given (toolName, input) pair satisfy every
 * matcher on this rule? Tool list is set-membership; field matchers are
 * regex tests against `String(input[key] ?? "")`.
 */
export function ruleMatches(
  rule: CompiledRule,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule.toolSet && !rule.toolSet.has(toolName)) return false;
  for (const { key, re } of rule.fieldMatchers) {
    if (!re.test(String(input[key] ?? ""))) return false;
  }
  return true;
}

/**
 * Walks the policy rules in declaration order, returning the first matching
 * rule's decision. Falls through to {@link Policy.default} if no rule fires.
 *
 * Rewrite rules return `allow` with the rewritten input substituted into the
 * named field — callers should treat the returned `updatedInput` as the new
 * source of truth.
 */
export function evaluatePolicy(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
): Decision {
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, toolName, input)) continue;
    const raw = rule.raw;
    if (raw.action === "allow") return { behavior: "allow", updatedInput: input };
    if (raw.action === "deny") return { behavior: "deny", message: raw.reason ?? "denied by policy" };
    if (raw.action === "ask") return { behavior: "ask" };
    if (raw.action === "rewrite" && rule.rewriteRe && raw.rewriteTo) {
      const field = raw.rewriteField ?? "command";
      const next = String(input[field] ?? "").replace(rule.rewriteRe, raw.rewriteTo);
      return { behavior: "allow", updatedInput: { ...input, [field]: next } };
    }
  }
  if (policy.default === "allow") return { behavior: "allow", updatedInput: input };
  if (policy.default === "deny") return { behavior: "deny", message: "no rule matched (default deny)" };
  return { behavior: "ask" };
}
