// json-schema-validator.ts — the manager-side concretion that makes a step node's
// declared JSON-Schema `outputSchema` actually validate (§Issue B). The pure core
// step executor only knows the duck-typed ZodLike { safeParse } abstraction
// (asZod): the code-DSL path supplies a live Zod schema, but an orchestrator-
// emitted run-inline spec carries a PLAIN JSON-Schema object with no safeParse, so
// the executor silently skipped validation and bound raw report text. Here we
// compile that JSON-Schema into the safeParse shape and attach it at run
// acceptance, keeping JSON-Schema knowledge OUT of pure core (DIP — core depends on
// the abstraction, the manager supplies the concretion).
//
// The validator covers the JSON-Schema subset the orchestrator emits:
// object/properties/required, array/items, the primitives (string / number /
// integer / boolean), enum, and nullability (`nullable:true` or a `type` array
// carrying "null"). Anything outside the subset validates permissively — we never
// reject data we cannot describe.

import { forEachNode } from "../../core/src/workflow/node-scope.ts";
import { safeStringify } from "../../infra/src/util/json.ts";
import type { WorkflowNode } from "../../contracts/src/workflow-node.ts";

interface ParseOk { success: true; data: unknown }
interface ParseErr { success: false; error: unknown }
export interface ZodLike {
  safeParse(_value: unknown): ParseOk | ParseErr;
}

function hasSafeParse(schema: unknown): boolean {
  return !!schema && typeof (schema as ZodLike).safeParse === "function";
}

// Compile a JSON-Schema object into the ZodLike { safeParse } the executor's asZod
// duck-type accepts. data is the value unchanged (validation, not transformation).
export function compileJsonSchema(schema: unknown): ZodLike {
  return {
    safeParse(value: unknown): ParseOk | ParseErr {
      const errors = validate(schema, value, "value");
      return errors.length === 0
        ? { success: true, data: value }
        : { success: false, error: errors.join("; ") };
    },
  };
}

// Attach a compiled validator to every `step` node that carries a plain
// JSON-Schema `outputSchema` (a live Zod from the code-DSL path already has
// safeParse and is left untouched). Mutates the accepted spec tree in place.
export function attachOutputValidators(root: WorkflowNode): void {
  forEachNode(root, (node) => {
    if (node.type !== "step") return;
    if (node.outputSchema === undefined || hasSafeParse(node.outputSchema)) return;
    (node as { outputSchema?: unknown }).outputSchema = compileJsonSchema(node.outputSchema);
  });
}

type JsonSchema = Record<string, unknown>;

function asSchema(schema: unknown): JsonSchema | null {
  return schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as JsonSchema) : null;
}

// Normalize the `type` keyword to a set, folding a `["string","null"]` union and a
// `nullable:true` flag into a single nullability signal.
function typesOf(schema: JsonSchema): { types: string[]; nullable: boolean } {
  const raw = schema.type;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const types = list.filter((t): t is string => typeof t === "string" && t !== "null");
  const nullable = schema.nullable === true || (Array.isArray(raw) && raw.includes("null"));
  return { types, nullable };
}

function validate(schemaRaw: unknown, value: unknown, path: string): string[] {
  const schema = asSchema(schemaRaw);
  if (!schema) return []; // not a schema object → nothing to enforce

  const { types, nullable } = typesOf(schema);
  if (value === null) return nullable ? [] : (types.length ? [`${path}: expected ${types.join("|")}, got null`] : []);

  const errors: string[] = [];

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: ${safeStringify(value)} is not one of the allowed values`);
  }

  for (const type of types) {
    const typeError = checkType(type, value, path);
    if (typeError) errors.push(typeError);
  }

  if (types.includes("object") && isPlainObject(value)) {
    errors.push(...validateObject(schema, value, path));
  }
  if (types.includes("array") && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return errors;
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && value[key] === undefined) errors.push(`${path}.${key}: required field missing`);
  }
  const properties = asSchema(schema.properties);
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) errors.push(...validate(propSchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

function checkType(type: string, value: unknown, path: string): string | null {
  switch (type) {
    case "object": return isPlainObject(value) ? null : `${path}: expected object, got ${kindOf(value)}`;
    case "array": return Array.isArray(value) ? null : `${path}: expected array, got ${kindOf(value)}`;
    case "string": return typeof value === "string" ? null : `${path}: expected string, got ${kindOf(value)}`;
    case "boolean": return typeof value === "boolean" ? null : `${path}: expected boolean, got ${kindOf(value)}`;
    case "number": return typeof value === "number" && Number.isFinite(value) ? null : `${path}: expected number, got ${kindOf(value)}`;
    case "integer": return typeof value === "number" && Number.isInteger(value) ? null : `${path}: expected integer, got ${kindOf(value)}`;
    default: return null; // unknown type keyword → permissive
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
