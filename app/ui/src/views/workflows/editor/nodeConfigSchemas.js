// The single source of truth the typed Inspector renders from: for every graph
// node kind, the CONFIG fields it exposes and the CONTROL that edits each. The v2
// graph contract stores node `config` as z.unknown() (workflow-graph.ts:107), so
// the per-kind fields are NOT in the v2 schema — they are defined by the v1 node
// interfaces (contracts/src/workflow-node.ts). This module reproduces those fields
// so the inspector is a generic renderer driven by data: adding a kind = adding an
// entry here, not editing the inspector.
//
// THE ENUM→SELECTOR RULE (operator hard rule): every enum / closed-set field is a
// selector (select | segmented), never a free string. Only genuinely free values
// (a prompt, a binding ref, a JSON-Schema body) are text. The `optionsKey` names a
// live/static option source the inspector resolves at render time.
//
// Kept free of React/DOM so it unit-tests in the repo's node test environment like
// graphModel.js / portTypes.js. nodeConfigSchemas.test.js asserts the kind set +
// every enum option set stay in sync with the contracts (so they can't drift).

import { PORT_TYPES } from "./portTypes.js";

// ---- control vocabulary -----------------------------------------------------
// The closed set of control types the inspector knows how to render. The guard
// test asserts every field uses one of these.
export const CONTROL_TYPES = [
  "text", // free single-line (script id, expert id)
  "textarea", // free multi-line (a prompt)
  "select", // dropdown over a (often catalog-backed) closed set
  "segmented", // chip row for a short enum
  "number", // bounded integer (maxIterations, timeoutMs, loop limit)
  "tags", // string[] (toolsAllow/Deny, script args)
  "binding-ref", // {{nodes.<id>.output}} / {{args.*}} / {{item}} text + suggest
  "predicate", // structured eq/exists/and/or builder
  "json-schema", // JSON-Schema body (CodeMirror text + validate)
  "json-literal", // any JSON literal (CodeMirror text + validate)
  "spawn-loop", // the worker self-loop sub-form (SpawnLoop)
  "sub-canvas", // the loop body — a nested graph editor
];

// The option SOURCES a select/segmented field may name. The inspector resolves
// these to concrete option lists from live catalogs (models, transform fns,
// worker-definitions, workflow definitions) or the static enums below.
export const OPTION_KEYS = ["models", "efforts", "transformFns", "workerDefs", "definitions", "loopStrategy"];

// ---- static enum value sets (mirrored from contracts; guard-tested) ---------
// EFFORT_LEVELS — contracts/src/shared.ts. The inspector further GATES these on
// the selected model's capability (lib/models effortChoicesFor); this is the full
// spawn-time set used as the fallback / sync anchor.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// LoopStrategySchema — contracts/src/loop.ts. The worker self-loop goal-check mode.
export const LOOP_STRATEGIES = ["command", "judge", "hybrid"];

// PredicateSchema ops — contracts/src/workflow-node.ts. Drives the predicate builder.
export const PREDICATE_OPS = ["eq", "exists", "and", "or"];

// Re-exported for the per-port type selector (already mirrors the contract).
export { PORT_TYPES };

// ---- field helpers ----------------------------------------------------------
const f = (key, label, control, extra = {}) => ({ key, label, control, ...extra });

// Transform-family `fn` field — a dropdown sourced live from the catalog. `role`
// is a display hint (filter expects predicates, accumulate reducers, dedup/tally
// key extractors); the list itself always comes from the endpoint, never hardcoded.
const fnField = (role, { required = false } = {}) =>
  f("fn", "Transform fn", "select", { optionsKey: "transformFns", role, required, help: "registered pure fn (from the catalog)" });

const overField = (required = true) =>
  f("over", "Over (binding)", "binding-ref", { required, placeholder: "{{nodes.<id>.output}}" });

// ---- the per-kind config schemas (all 14 GRAPH_NODE_KINDS) -------------------
// `fields: []` = the kind has no node-level config (input/output/merge). Ports are
// edited separately (the Ports section); experts[]/argsSchema are graph-level
// (GraphMetaPanel), not node config.
export const NODE_CONFIG_SCHEMAS = {
  input: { fields: [], note: "Graph entry. The run-args shape is the graph-level argsSchema (Graph settings), not a node field." },
  output: { fields: [] },

  worker: {
    fields: [
      f("from", "From (worker def)", "select", { optionsKey: "workerDefs", placeholder: "general-purpose", help: "omit ⇒ general-purpose" }),
      f("prompt", "Prompt", "textarea", { required: true, placeholder: "Directive for the worker…" }),
      f("model", "Model", "select", { optionsKey: "models" }),
      f("effort", "Effort", "segmented", { optionsKey: "efforts", gatedBy: "model" }),
      f("toolsAllow", "Tools allow", "tags", { placeholder: "Read, Edit, Bash…" }),
      f("toolsDeny", "Tools deny", "tags"),
      f("outputSchema", "Output schema", "json-schema", { help: "JSON-Schema the typed report must match" }),
      f("loop", "Self-loop", "spawn-loop"),
    ],
  },

  script: {
    trustGate: true, // a graph with a script node can be saved + run-by-name, but NOT run-inline
    fields: [
      f("script", "Script id", "text", { required: true, placeholder: "name (resolved under ~/.eos/scripts)", help: "an allowlisted NAME, not a path" }),
      overField(false),
      f("args", "Args", "tags", { help: "binding-resolved argv" }),
      f("timeoutMs", "Timeout (ms)", "number", { min: 1 }),
    ],
  },

  transform: { fields: [fnField("any", { required: true }), overField(true)] },
  map: { fields: [fnField("any", { required: true }), overField(true)] },
  filter: { fields: [fnField("predicate", { required: true }), overField(true)] },
  dedup: { fields: [overField(true), fnField("key")] },
  tally: { fields: [overField(true), fnField("key")] },
  accumulate: {
    fields: [fnField("reducer", { required: true }), overField(true), f("init", "Initial value", "json-literal")],
  },

  branch: { fields: [f("predicate", "Predicate", "predicate", { required: true })] },
  merge: { fields: [], note: "Ordered fan-in — first non-skipped input by edge order wins." },

  loop: {
    fields: [
      f("body", "Loop body", "sub-canvas", { required: true, help: "the encapsulated body sub-graph" }),
      f("until", "Until (predicate)", "predicate"),
      f("maxIterations", "Max iterations", "number", { min: 1 }),
      f("over", "Over (binding)", "binding-ref", { placeholder: "{{nodes.<id>.output}} (forEach/pipeline)" }),
    ],
  },

  subGraph: {
    fields: [
      f("name", "Workflow", "select", { optionsKey: "definitions", required: true, help: "which workflow to invoke" }),
      f("args", "Args", "json-literal"),
    ],
  },
};

// The kinds this module covers — guard-tested to equal the contract's GRAPH_NODE_KINDS.
export const CONFIG_SCHEMA_KINDS = Object.keys(NODE_CONFIG_SCHEMAS);

// The config field schema for a kind ([] when the kind has no config / is unknown).
export function fieldsForKind(kind) {
  return NODE_CONFIG_SCHEMAS[kind]?.fields ?? [];
}

export function schemaForKind(kind) {
  return NODE_CONFIG_SCHEMAS[kind] ?? { fields: [] };
}

// ---- config mutation (the controlled boundary into graphModel) --------------
// A field's value is "empty" when it should be OMITTED from config entirely (so a
// blank model/effort never lands in the saved payload) — matches v1 optionality.
export function isEmptyValue(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

// Immutably set one config field; an empty value deletes the key, and a config
// that becomes empty collapses to undefined (so toWorkflowGraph drops it).
export function setConfigField(config, key, value) {
  const next = { ...(config || {}) };
  if (isEmptyValue(value)) delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : undefined;
}

// ---- binding-ref autocomplete ----------------------------------------------
// Suggestions for a binding-ref field: the run args, the per-item ref (inside a
// loop/map body), and every OTHER node's output. Not strictly upstream — the
// binding scope resolves by id at runtime — but enough to author refs by clicking.
export function bindingSuggestions(graph, nodeId) {
  const out = ["{{args}}", "{{item}}"];
  for (const n of graph?.nodes ?? []) {
    if (n.id === nodeId || n.kind === "input" || n.kind === "output") continue;
    out.push(`{{nodes.${n.id}.output}}`);
  }
  return out;
}
