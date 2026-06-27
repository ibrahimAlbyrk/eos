// Centralized prompt-system schemas — the single source of truth for the
// on-disk prompt frontmatter (Layer 1) and the DPI metadata + session facts
// (Layer 2). Pure zod; no runtime logic lives here.

import { z } from "zod";

// --- Layer 1: variable manifest -------------------------------------------
// A prompt declares the variables it interpolates as a flat list of names —
// documentation + an authoring check, mirroring Claude Code's `variables:`
// manifest. No types/defaults/required: a missing variable just renders empty.
// Convention: names are UPPER_SNAKE_CASE (a non-conforming name only warns).

export const VariableNameSchema = z.string().min(1);

// --- Layer 2: DPI conditions ----------------------------------------------
// A condition is evaluated against the session FactSet. Leaf form names one
// fact + one operator; combinators (all/any/not) compose them. The operator
// set is closed on purpose — richer logic belongs in a derived fact, never in
// an ad-hoc expression language.

export interface ConditionLeaf {
  fact: string;
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  nin?: unknown[];
  exists?: boolean;
  truthy?: boolean;
}
export type Condition =
  | ConditionLeaf
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const ConditionLeafSchema = z.object({
  fact: z.string().min(1),
  eq: z.unknown().optional(),
  ne: z.unknown().optional(),
  in: z.array(z.unknown()).optional(),
  nin: z.array(z.unknown()).optional(),
  exists: z.boolean().optional(),
  truthy: z.boolean().optional(),
});

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }),
    z.object({ any: z.array(ConditionSchema) }),
    z.object({ not: ConditionSchema }),
    ConditionLeafSchema,
  ]),
);

// --- Layer 2: fragment metadata -------------------------------------------

export const PROMPT_LAYERS = ["core", "environment", "role", "tool", "safety", "custom"] as const;
export const PromptLayerSchema = z.enum(PROMPT_LAYERS);
export type PromptLayer = z.infer<typeof PromptLayerSchema>;

export const DpiMetaSchema = z.object({
  layer: PromptLayerSchema.default("custom"),
  priority: z.number().int().default(100),
  when: ConditionSchema.optional(),
  overrides: z.array(z.string()).optional(),
});
export type DpiMeta = z.infer<typeof DpiMetaSchema>;

// --- The full prompt frontmatter ------------------------------------------
// Passthrough so authoring-only keys (e.g. argument-hint) survive untouched.

export const PromptFrontmatterSchema = z
  .object({
    id: z.string().optional(),
    description: z.string().optional(),
    variables: z.array(VariableNameSchema).default([]),
    // Opaque to Layer 1 — the parser/registry never depend on the DPI schema.
    // Layer 2 (toFragment) validates this block against DpiMetaSchema lazily.
    dpi: z.unknown().optional(),
  })
  .passthrough();
export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

// --- Layer 2: the session fact snapshot -----------------------------------
// Captured once at session start; conditions key on it and fragments may
// interpolate it. Passthrough so new facts don't break older data.

export const SessionFactsSchema = z
  .object({
    role: z.enum(["orchestrator", "worker", "git", "workflow-worker"]),
    isSubagent: z.boolean(),
    isGitRepo: z.boolean(),
    isWorktree: z.boolean(),
    isAttached: z.boolean(),
    model: z.string(),
    effort: z.string().nullable(),
    permissionMode: z.string(),
    os: z.string(),
    shell: z.string(),
    hasMcp: z.boolean(),
    // Worker was spawned with collaborate=true → gate the peer-collaboration
    // fragment on it. Session-immutable (set once at spawn).
    canCollaborate: z.boolean(),
    // The worker's definition name, set once at spawn → session-IMMUTABLE → legal to
    // gate fragment selection on. "" = untyped (base worker).
    workerDefinition: z.string().default(""),
  })
  .passthrough();
export type SessionFacts = z.infer<typeof SessionFactsSchema>;
