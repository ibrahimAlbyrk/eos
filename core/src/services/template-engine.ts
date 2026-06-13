// The {{ }} mini-language: a deliberately tiny interpreter. Grammar is
// interpolation ({{ path }}) plus one conditional block ({{#if path}} … {{/if}}
// and its {{#unless}} negation). No loops, no operators, no nested expressions —
// anything bigger is a separate fragment (Layer 2) or a derived value.
//
// parseTemplate is STRICT: every token must be a valid path / #if|#unless / close,
// blocks must be balanced, and closers must match their opener. A malformed token
// (e.g. a literal `{{`/`}}` in prose, an unclosed block, a mismatched closer)
// THROWS rather than silently corrupting the rendered prompt — the registry
// catches it and skips the bad prompt, and `eos prompts validate` surfaces it.

import { ValidationError } from "../errors/index.ts";
import { isTruthy } from "../domain/prompt.ts";
import type { TemplateNode, VariableScope, VariableValue } from "../domain/prompt.ts";

const TOKEN = /\{\{\s*(.*?)\s*\}\}/gs;
const PATH = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export interface ParsedTemplate {
  nodes: TemplateNode[];
  referenced: string[];
}

interface Frame {
  kind: "root" | "if" | "unless";
  body: TemplateNode[];
}

export function parseTemplate(body: string): ParsedTemplate {
  const root: TemplateNode[] = [];
  const stack: Frame[] = [{ kind: "root", body: root }];
  const referenced = new Set<string>();
  const pushText = (text: string) => {
    if (text) stack[stack.length - 1].body.push({ kind: "text", value: text });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(body)) !== null) {
    pushText(body.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = m[1].trim();

    if (inner === "/if" || inner === "/unless") {
      const expected = inner.slice(1); // "if" | "unless"
      const frame = stack[stack.length - 1];
      if (frame.kind !== expected) {
        throw new ValidationError(`template: {{${inner}}} has no matching {{#${expected}}}`);
      }
      stack.pop();
    } else if (inner.startsWith("#if ") || inner.startsWith("#unless ")) {
      const negate = inner.startsWith("#unless ");
      const path = inner.slice(inner.indexOf(" ") + 1).trim();
      if (!PATH.test(path)) throw new ValidationError(`template: invalid path in {{${inner}}}`);
      referenced.add(rootName(path));
      const node: TemplateNode = { kind: "cond", path, negate, body: [] };
      stack[stack.length - 1].body.push(node);
      stack.push({ kind: negate ? "unless" : "if", body: node.body });
    } else if (PATH.test(inner)) {
      referenced.add(rootName(inner));
      stack[stack.length - 1].body.push({ kind: "interp", path: inner });
    } else {
      throw new ValidationError(`template: malformed token {{${inner}}}`);
    }
  }
  pushText(body.slice(last));

  if (stack.length !== 1) {
    throw new ValidationError(`template: ${stack.length - 1} unclosed {{#if}}/{{#unless}} block(s)`);
  }
  return { nodes: root, referenced: [...referenced] };
}

export function renderTemplate(nodes: TemplateNode[], scope: VariableScope): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += n.value;
    } else if (n.kind === "interp") {
      out += stringify(resolvePath(scope, n.path));
    } else {
      const truthy = isTruthy(resolvePath(scope, n.path));
      if (truthy !== n.negate) out += renderTemplate(n.body, scope);
    }
  }
  return out;
}

function rootName(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

function resolvePath(scope: VariableScope, path: string): VariableValue {
  const parts = path.split(".");
  let cur: unknown = scope[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur as VariableValue;
}

function stringify(v: VariableValue): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join("\n");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
