// dsl.ts — the trusted, author-time fluent Builder (§3.2). `wf.define` runs a
// builder callback that constructs a WorkflowNode IR tree; the Builder is the ONE
// code front-end, and it only ever builds data — it executes nothing. Both this
// Builder and the orchestrator-emitted declarative spec lower to the same
// Zod-validated IR, which the interpreter walks. Container nodes may omit `id`
// (an explicit `id` is the binding key, so leaf `step`s always name themselves);
// a per-definition counter mints stable, deterministic ids for the rest. Pure: no
// Node, no Date.now/Math.random.

import type {
  WorkflowNode, StepNode, SequenceNode, ParallelNode, PipelineNode, ForEachNode,
  ConditionalNode, LoopUntilNode, PhaseNode, SubWorkflowNode, TransformNode, MapNode,
  FilterNode, DedupNode, TallyNode, AccumulateNode, Predicate,
} from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition, ExpertSpec } from "../../../contracts/src/workflow.ts";

export interface StepOpts {
  id: string;
  from?: string;
  prompt: string;
  model?: string;
  effort?: StepNode["effort"];
  toolsAllow?: string[];
  toolsDeny?: string[];
  outputSchema?: unknown;
}

export interface WorkflowBuilder {
  step(opts: StepOpts): StepNode;
  sequence(children: WorkflowNode[], id?: string): SequenceNode;
  parallel(children: WorkflowNode[], id?: string): ParallelNode;
  pipeline(opts: { id?: string; over: string; stages: WorkflowNode[] }): PipelineNode;
  forEach(opts: { id?: string; over: string; body: WorkflowNode }): ForEachNode;
  conditional(opts: { id?: string; predicate: Predicate; then: WorkflowNode; else?: WorkflowNode }): ConditionalNode;
  loopUntil(opts: { id?: string; body: WorkflowNode; until?: Predicate; maxIterations?: number }): LoopUntilNode;
  phase(label: string, body: WorkflowNode, id?: string): PhaseNode;
  subWorkflow(opts: { id?: string; name: string; args?: unknown }): SubWorkflowNode;
  transform(opts: { id?: string; fn: string; over: string }): TransformNode;
  map(opts: { id?: string; fn: string; over: string }): MapNode;
  filter(opts: { id?: string; fn: string; over: string }): FilterNode;
  dedup(opts: { id?: string; over: string; fn?: string }): DedupNode;
  tally(opts: { id?: string; over: string; fn?: string }): TallyNode;
  accumulate(opts: { id?: string; fn: string; over: string; init?: unknown }): AccumulateNode;
}

// What the build callback returns; lowered into a full WorkflowDefinition.
export interface WorkflowDraft {
  description?: string;
  experts?: ExpertSpec[];
  root: WorkflowNode;
}

class Builder implements WorkflowBuilder {
  private counter = 0;

  private nextId(kind: string): string {
    this.counter += 1;
    return `${kind}-${this.counter}`;
  }

  step(opts: StepOpts): StepNode {
    return {
      type: "step", id: opts.id, from: opts.from, prompt: opts.prompt,
      model: opts.model, effort: opts.effort, toolsAllow: opts.toolsAllow,
      toolsDeny: opts.toolsDeny, outputSchema: opts.outputSchema,
    };
  }

  sequence(children: WorkflowNode[], id?: string): SequenceNode {
    return { type: "sequence", id: id ?? this.nextId("sequence"), children };
  }

  parallel(children: WorkflowNode[], id?: string): ParallelNode {
    return { type: "parallel", id: id ?? this.nextId("parallel"), children };
  }

  pipeline(opts: { id?: string; over: string; stages: WorkflowNode[] }): PipelineNode {
    return { type: "pipeline", id: opts.id ?? this.nextId("pipeline"), over: opts.over, stages: opts.stages };
  }

  forEach(opts: { id?: string; over: string; body: WorkflowNode }): ForEachNode {
    return { type: "forEach", id: opts.id ?? this.nextId("forEach"), over: opts.over, body: opts.body };
  }

  conditional(opts: { id?: string; predicate: Predicate; then: WorkflowNode; else?: WorkflowNode }): ConditionalNode {
    return { type: "conditional", id: opts.id ?? this.nextId("conditional"), predicate: opts.predicate, then: opts.then, else: opts.else };
  }

  loopUntil(opts: { id?: string; body: WorkflowNode; until?: Predicate; maxIterations?: number }): LoopUntilNode {
    return { type: "loopUntil", id: opts.id ?? this.nextId("loopUntil"), body: opts.body, until: opts.until, maxIterations: opts.maxIterations };
  }

  phase(label: string, body: WorkflowNode, id?: string): PhaseNode {
    return { type: "phase", id: id ?? this.nextId("phase"), label, body };
  }

  subWorkflow(opts: { id?: string; name: string; args?: unknown }): SubWorkflowNode {
    return { type: "subWorkflow", id: opts.id ?? this.nextId("subWorkflow"), name: opts.name, args: opts.args };
  }

  transform(opts: { id?: string; fn: string; over: string }): TransformNode {
    return { type: "transform", id: opts.id ?? this.nextId("transform"), fn: opts.fn, over: opts.over };
  }

  map(opts: { id?: string; fn: string; over: string }): MapNode {
    return { type: "map", id: opts.id ?? this.nextId("map"), fn: opts.fn, over: opts.over };
  }

  filter(opts: { id?: string; fn: string; over: string }): FilterNode {
    return { type: "filter", id: opts.id ?? this.nextId("filter"), fn: opts.fn, over: opts.over };
  }

  dedup(opts: { id?: string; over: string; fn?: string }): DedupNode {
    return { type: "dedup", id: opts.id ?? this.nextId("dedup"), over: opts.over, fn: opts.fn };
  }

  tally(opts: { id?: string; over: string; fn?: string }): TallyNode {
    return { type: "tally", id: opts.id ?? this.nextId("tally"), over: opts.over, fn: opts.fn };
  }

  accumulate(opts: { id?: string; fn: string; over: string; init?: unknown }): AccumulateNode {
    return { type: "accumulate", id: opts.id ?? this.nextId("accumulate"), fn: opts.fn, over: opts.over, init: opts.init };
  }
}

export const wf = {
  define(name: string, build: (b: WorkflowBuilder) => WorkflowDraft): WorkflowDefinition {
    const draft = build(new Builder());
    return { name, description: draft.description, experts: draft.experts, root: draft.root };
  },
};
