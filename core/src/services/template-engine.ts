// The {{ }} mini-language: a deliberately tiny interpreter. Grammar is
// interpolation ({{ path }}) plus one conditional block ({{#if path}} … {{/if}}
// and its {{#unless}} negation). No loops, no operators, no nested expressions —
// anything bigger is a separate fragment (Layer 2) or a derived value. Pure:
// parseTemplate builds an AST, renderTemplate walks it against a resolved scope.

import type { TemplateNode, VariableScope, VariableValue } from "../domain/prompt.ts";

const TOKEN = /\{\{\s*(.*?)\s*\}\}/gs;

export interface ParsedTemplate {
  nodes: TemplateNode[];
  referenced: string[];
}

export function parseTemplate(body: string): ParsedTemplate {
  const root: TemplateNode[] = [];
  const stack: TemplateNode[][] = [root];
  const referenced = new Set<string>();
  const pushText = (text: string) => {
    if (text) stack[stack.length - 1].push({ kind: "text", value: text });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(body)) !== null) {
    pushText(body.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = m[1].trim();

    if (inner.startsWith("#if ") || inner.startsWith("#unless ")) {
      const negate = inner.startsWith("#unless ");
      const path = inner.slice(inner.indexOf(" ") + 1).trim();
      referenced.add(rootName(path));
      const node: TemplateNode = { kind: "cond", path, negate, body: [] };
      stack[stack.length - 1].push(node);
      stack.push(node.body);
    } else if (inner === "/if" || inner === "/unless") {
      if (stack.length > 1) stack.pop();
    } else if (inner.length > 0) {
      referenced.add(rootName(inner));
      stack[stack.length - 1].push({ kind: "interp", path: inner });
    }
  }
  pushText(body.slice(last));

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

export function resolvePath(scope: VariableScope, path: string): VariableValue {
  const parts = path.split(".");
  let cur: unknown = scope[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur as VariableValue;
}

export function isTruthy(v: VariableValue): boolean {
  if (v == null || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function stringify(v: VariableValue): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join("\n");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
