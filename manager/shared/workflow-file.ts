// workflow-file — pure, daemon-free parsing + validation of a workflow definition
// FILE (design A6.1/A6.3). The `eos workflow validate` / `run <file>` verbs use
// this to load a hand-authored definition with ZERO LLM and zero daemon: read the
// file, parse JSON (or `.md` YAML frontmatter), then validate against the canonical
// contract — a v2 node GRAPH (version:2) gets the full structural WorkflowGraphSchema
// (id-uniqueness, dangling/typed/self edges, acyclicity); anything else is a v1 tree.
// Discriminating BEFORE validation keeps the error messages precise (the v1/v2 union
// would otherwise report failures from both arms).

import { parse as parseYaml } from "yaml";
import { WorkflowDefinitionSchema } from "../../contracts/src/workflow.ts";
import {
  WorkflowGraphSchema, isWorkflowGraph, type AnyWorkflowDefinition,
} from "../../contracts/src/workflow-graph.ts";
import type { z } from "zod";

export interface WorkflowFileOk {
  ok: true;
  def: AnyWorkflowDefinition;
  kind: "graph" | "tree";
  name: string;
}
export interface WorkflowFileErr {
  ok: false;
  errors: string[];
}
export type WorkflowFileResult = WorkflowFileOk | WorkflowFileErr;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Parse raw file content into a candidate object: JSON when `isJson`, else a `.md`
// file whose YAML frontmatter holds the definition (the markdown body folds into
// `description` when the frontmatter omits one — the FileWorkflowDefinitionSource
// convention).
export function parseWorkflowSource(
  content: string,
  isJson: boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (isJson) {
    try {
      return { ok: true, value: JSON.parse(content) };
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${msg(e)}` };
    }
  }
  const { frontmatter, body } = splitFrontmatter(content);
  if (!frontmatter) return { ok: false, error: "no YAML frontmatter found (expected a leading --- block)" };
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (e) {
    return { ok: false, error: `invalid YAML frontmatter: ${msg(e)}` };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "frontmatter is not an object" };
  const fm = parsed as Record<string, unknown>;
  const trimmed = body.trim();
  if (fm.description === undefined && trimmed) fm.description = trimmed;
  return { ok: true, value: fm };
}

// Validate a parsed candidate against the workflow contract, returning either the
// runnable definition (with its kind) or a list of precise, path-prefixed errors.
export function validateWorkflowDoc(candidate: unknown): WorkflowFileResult {
  if (isWorkflowGraph(candidate)) {
    const parsed = WorkflowGraphSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
    return { ok: true, def: parsed.data, kind: "graph", name: parsed.data.name };
  }
  const parsed = WorkflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  return { ok: true, def: parsed.data, kind: "tree", name: parsed.data.name };
}

// Parse + validate a file's content in one call.
export function loadWorkflowFile(content: string, isJson: boolean): WorkflowFileResult {
  const parsed = parseWorkflowSource(content, isJson);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateWorkflowDoc(parsed.value);
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}
