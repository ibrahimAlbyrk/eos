// Permission policy contract: rules (input) and decisions (output).
// The pure engine that compiles + evaluates these lives in core/domain/policy.
//
// Adding a new behavior (e.g. "escalate") requires a new variant in
// DecisionSchema AND a new branch in the policy evaluator AND the daemon's
// /policy/decide handler — all type-checked end-to-end because the
// discriminated union forces exhaustive handling.

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";

export const PolicyBehaviorSchema = z.enum(["allow", "deny", "ask", "rewrite"]);
export type PolicyBehavior = z.infer<typeof PolicyBehaviorSchema>;

// Raw rule shape as authored in policy.yaml.
export const PolicyRuleSchema = z.object({
  match: z
    .object({
      tool: z.string(),
      pattern: z.string().optional(),
    })
    .optional(),
  behavior: PolicyBehaviorSchema,
  message: z.string().optional(),
  rewrite: z.unknown().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// Policy file root (top-level policy.yaml structure).
export const PolicyFileSchema = z.object({
  default: PolicyBehaviorSchema.default("ask"),
  ttlMs: z.number().int().positive().optional(),
  rules: z.array(PolicyRuleSchema).default([]),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export const AllowVariant = z.object({
  behavior: z.literal("allow"),
  updatedInput: UnknownRecordSchema.optional(),
  message: z.string().optional(),
});

export const DenyVariant = z.object({
  behavior: z.literal("deny"),
  message: z.string(),
});

// What the daemon/gateway returns to the hook caller. "ask" is internal to
// the daemon — it never reaches the hook (the daemon resolves it via the
// pending-permissions long-poll into allow|deny).
export const DecisionSchema = z.discriminatedUnion("behavior", [
  AllowVariant,
  DenyVariant,
  z.object({ behavior: z.literal("ask") }),
]);
export type Decision = z.infer<typeof DecisionSchema>;

// The decision shape exposed externally (hook, MCP gateway) — without "ask".
export const ExternalDecisionSchema = z.discriminatedUnion("behavior", [
  AllowVariant,
  DenyVariant,
]);
export type ExternalDecision = z.infer<typeof ExternalDecisionSchema>;
