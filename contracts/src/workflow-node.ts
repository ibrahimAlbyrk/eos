// The WorkflowNode IR — a recursive discriminated union that IS the workflow
// language. Both front-ends (the trusted author-time code Builder and the
// orchestrator-emitted declarative spec) lower to this one Zod-validated tree;
// the daemon-resident interpreter walks it, dispatching each node to its
// registered executor (one Strategy per `type`). Every node carries a stable
// `id` whose output lands in the run-scoped binding scope.
//
// Security posture (§3.2/§3.6): there is NO inline executable code in the IR.
// The deterministic glue/transform nodes reference a registered pure-function by
// NAME (`fn`) over a bound input (`over`) — the orchestrator is an LLM, so the
// declarative path never carries code into the daemon.
//
// The node TS types are hand-written (not `z.infer`) because the tree is
// recursive: `z.infer` over a self-referential `z.lazy` schema forms a type
// cycle TypeScript rejects. The member schemas stay plain `z.object` (so
// `z.discriminatedUnion` accepts them); their recursive fields defer through
// `z.lazy(() => WorkflowNodeSchema)`, and the interfaces below mirror them.

import { z } from "zod";
import { EffortSchema } from "./shared.ts";

type Effort = z.infer<typeof EffortSchema>;

// ---- Predicate — the Specification evaluated by conditional/loopUntil --------
// A small recursive expression over run bindings (`{{nodes.<id>.output}}` /
// `{{args.*}}` refs resolved before evaluation). Deliberately tiny: equality,
// presence, and boolean composition — NOT a general expression language.
export type Predicate =
  | { op: "eq"; left: string; right?: unknown }
  | { op: "exists"; ref: string }
  | { op: "and"; clauses: Predicate[] }
  | { op: "or"; clauses: Predicate[] };

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("eq"), left: z.string(), right: z.unknown() }),
    z.object({ op: z.literal("exists"), ref: z.string() }),
    z.object({ op: z.literal("and"), clauses: z.array(PredicateSchema) }),
    z.object({ op: z.literal("or"), clauses: z.array(PredicateSchema) }),
  ]),
);

// ---- node TS types ----------------------------------------------------------

// step — the only leaf that touches Eos (spawn ONE worker, await its report).
export interface StepNode {
  type: "step";
  id: string;
  from?: string;               // worker-definition name; omit ⇒ default
  prompt: string;
  model?: string;
  effort?: Effort;
  toolsAllow?: string[];
  toolsDeny?: string[];
  // JSON-Schema object the step's typed result (via submit_step_output) must
  // match; omitted ⇒ the status-prefixed report text is the output (§3.6 fallback).
  outputSchema?: unknown;
}
export interface SequenceNode {
  type: "sequence";
  id: string;
  children: WorkflowNode[];
}
export interface ParallelNode {
  type: "parallel";
  id: string;
  children: WorkflowNode[];
}
export interface PipelineNode {
  type: "pipeline";
  id: string;
  over: string;                // binding ref to the source list
  stages: WorkflowNode[];      // each item flows through all stages independently
}
export interface ForEachNode {
  type: "forEach";
  id: string;
  over: string;                // binding ref to the list; `{{item}}` in the body
  body: WorkflowNode;
}
export interface ConditionalNode {
  type: "conditional";
  id: string;
  predicate: Predicate;
  then: WorkflowNode;
  else?: WorkflowNode;
}
export interface LoopUntilNode {
  type: "loopUntil";
  id: string;
  body: WorkflowNode;
  until?: Predicate;
  maxIterations?: number;
}
export interface PhaseNode {
  type: "phase";
  id: string;
  label: string;
  body: WorkflowNode;
}
export interface SubWorkflowNode {
  type: "subWorkflow";
  id: string;
  name: string;
  args?: unknown;
}
// Deterministic glue/transform nodes (§3.2): `fn` names a registered pure
// function, `over` binds its input. No inline code.
export interface TransformNode {
  type: "transform";
  id: string;
  fn: string;
  over: string;
}
export interface MapNode {
  type: "map";
  id: string;
  fn: string;
  over: string;
}
export interface FilterNode {
  type: "filter";
  id: string;
  fn: string;
  over: string;
}
export interface DedupNode {
  type: "dedup";
  id: string;
  over: string;
  fn?: string;                 // key extractor; omitted ⇒ identity (§3.2 set-difference)
}
export interface TallyNode {
  type: "tally";
  id: string;
  over: string;
  fn?: string;                 // key to group by; omitted ⇒ identity (§3.2 majority vote)
}
export interface AccumulateNode {
  type: "accumulate";
  id: string;
  fn: string;                  // registered reducer
  over: string;
  init?: unknown;
}

// The union — exhaustive over all 15 node types.
export type WorkflowNode =
  | StepNode
  | SequenceNode
  | ParallelNode
  | PipelineNode
  | ForEachNode
  | ConditionalNode
  | LoopUntilNode
  | PhaseNode
  | SubWorkflowNode
  | TransformNode
  | MapNode
  | FilterNode
  | DedupNode
  | TallyNode
  | AccumulateNode;

// ---- per-node schemas (plain z.object → valid discriminatedUnion members) ----

export const StepNodeSchema = z.object({
  type: z.literal("step"),
  id: z.string(),
  from: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  toolsAllow: z.array(z.string()).optional(),
  toolsDeny: z.array(z.string()).optional(),
  outputSchema: z.unknown().optional(),
});

export const SequenceNodeSchema = z.object({
  type: z.literal("sequence"),
  id: z.string(),
  children: z.array(z.lazy(() => WorkflowNodeSchema)),
});

export const ParallelNodeSchema = z.object({
  type: z.literal("parallel"),
  id: z.string(),
  children: z.array(z.lazy(() => WorkflowNodeSchema)),
});

export const PipelineNodeSchema = z.object({
  type: z.literal("pipeline"),
  id: z.string(),
  over: z.string(),
  stages: z.array(z.lazy(() => WorkflowNodeSchema)),
});

export const ForEachNodeSchema = z.object({
  type: z.literal("forEach"),
  id: z.string(),
  over: z.string(),
  body: z.lazy(() => WorkflowNodeSchema),
});

export const ConditionalNodeSchema = z.object({
  type: z.literal("conditional"),
  id: z.string(),
  predicate: PredicateSchema,
  then: z.lazy(() => WorkflowNodeSchema),
  else: z.lazy(() => WorkflowNodeSchema).optional(),
});

// At least one of `until` / `maxIterations` should be set; the engine guards (a
// refine here would make the object a ZodEffects, illegal in a discriminatedUnion).
export const LoopUntilNodeSchema = z.object({
  type: z.literal("loopUntil"),
  id: z.string(),
  body: z.lazy(() => WorkflowNodeSchema),
  until: PredicateSchema.optional(),
  maxIterations: z.number().int().positive().optional(),
});

export const PhaseNodeSchema = z.object({
  type: z.literal("phase"),
  id: z.string(),
  label: z.string(),
  body: z.lazy(() => WorkflowNodeSchema),
});

export const SubWorkflowNodeSchema = z.object({
  type: z.literal("subWorkflow"),
  id: z.string(),
  name: z.string(),
  args: z.unknown().optional(),
});

export const TransformNodeSchema = z.object({
  type: z.literal("transform"),
  id: z.string(),
  fn: z.string(),
  over: z.string(),
});

export const MapNodeSchema = z.object({
  type: z.literal("map"),
  id: z.string(),
  fn: z.string(),
  over: z.string(),
});

export const FilterNodeSchema = z.object({
  type: z.literal("filter"),
  id: z.string(),
  fn: z.string(),
  over: z.string(),
});

export const DedupNodeSchema = z.object({
  type: z.literal("dedup"),
  id: z.string(),
  over: z.string(),
  fn: z.string().optional(),
});

export const TallyNodeSchema = z.object({
  type: z.literal("tally"),
  id: z.string(),
  over: z.string(),
  fn: z.string().optional(),
});

export const AccumulateNodeSchema = z.object({
  type: z.literal("accumulate"),
  id: z.string(),
  fn: z.string(),
  over: z.string(),
  init: z.unknown().optional(),
});

export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    StepNodeSchema,
    SequenceNodeSchema,
    ParallelNodeSchema,
    PipelineNodeSchema,
    ForEachNodeSchema,
    ConditionalNodeSchema,
    LoopUntilNodeSchema,
    PhaseNodeSchema,
    SubWorkflowNodeSchema,
    TransformNodeSchema,
    MapNodeSchema,
    FilterNodeSchema,
    DedupNodeSchema,
    TallyNodeSchema,
    AccumulateNodeSchema,
  ]),
);

// The canonical list of node `type` discriminators — the registry registers one
// executor per entry; an exhaustiveness check can assert full coverage.
export const WORKFLOW_NODE_TYPES = [
  "step",
  "sequence",
  "parallel",
  "pipeline",
  "forEach",
  "conditional",
  "loopUntil",
  "phase",
  "subWorkflow",
  "transform",
  "map",
  "filter",
  "dedup",
  "tally",
  "accumulate",
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
