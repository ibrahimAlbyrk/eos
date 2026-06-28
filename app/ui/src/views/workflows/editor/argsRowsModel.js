// Pure rows↔JSON model for the subGraph `args` builder. args are a free JSON
// object handed to a sub-workflow; the builder authors the common flat case as
// key/value rows. When the target workflow's argsSchema is resolvable, the rows are
// prefilled and typed from it (prefillRowsFromSchema / expectedArgType) so the
// operator fills a KNOWN shape rather than guessing keys.
//
// Only flat objects with scalar values are representable as rows. A nested-object
// or array value is advanced: it stays in the raw JSON editor and
// describeNonRepresentableArgs says why, so the builder never clobbers it.
// React/DOM-free like predicateModel.js. Literal coercion (no target type) reuses
// predicateModel.coerceLiteral so an args literal types the same way an eq literal does.

import { isPlainObject } from "./jsonSchemaCheck.js";
import { coerceLiteral } from "./predicateModel.js";

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

export function emptyArgRow() {
  return { key: "", value: undefined };
}

export function isRepresentableArgs(value) {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isScalar);
}

export function describeNonRepresentableArgs(value) {
  if (isRepresentableArgs(value)) return null;
  if (!isPlainObject(value)) return "args is not a JSON object";
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) return `"${k}" is an array`;
    if (isPlainObject(v)) return `"${k}" is a nested object`;
  }
  return "uses non-scalar values";
}

// Existing args → rows (the inverse of rowsToArgs). Values are kept verbatim.
export function argsToRows(value) {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([key, v]) => ({ key, value: v }));
}

// Compile rows to an args object. Unnamed rows and unset values (undefined) are
// dropped; an empty result ⇒ undefined (the field is omitted).
export function rowsToArgs(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || typeof r.key !== "string" || r.key.trim() === "" || r.value === undefined) continue;
    out[r.key.trim()] = r.value;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- target-schema awareness (prefill + typing) -----------------------------

// The declared scalar type for a key in the target's argsSchema (a `["string","null"]`
// union reads as its non-null member). undefined ⇒ no known type → free coercion.
export function expectedArgType(targetSchema, key) {
  if (!isPlainObject(targetSchema) || !isPlainObject(targetSchema.properties)) return undefined;
  const sub = targetSchema.properties[key];
  if (!isPlainObject(sub)) return undefined;
  const t = Array.isArray(sub.type) ? sub.type.find((x) => x !== "null") : sub.type;
  return typeof t === "string" ? t : undefined;
}

export function requiredArgKeys(targetSchema) {
  if (!isPlainObject(targetSchema) || !Array.isArray(targetSchema.required)) return [];
  return targetSchema.required.filter((k) => typeof k === "string");
}

// One empty-valued row per declared property, in schema order — the prefilled shape.
export function prefillRowsFromSchema(targetSchema) {
  if (!isPlainObject(targetSchema) || !isPlainObject(targetSchema.properties)) return [];
  return Object.keys(targetSchema.properties).map((key) => ({ key, value: undefined }));
}

// The rows to seed the builder with: existing args if present, else the prefilled
// shape from the target schema (so selecting a sub-workflow surfaces its keys).
export function initialArgRows(value, targetSchema) {
  if (isPlainObject(value) && Object.keys(value).length) return argsToRows(value);
  return prefillRowsFromSchema(targetSchema);
}

// Coerce the row's input text to a stored value. Empty ⇒ undefined (unset, dropped
// on compile). With a known target type the text is coerced to it (an unparseable
// number is left as text so step-1 validation flags the mismatch); without one it
// falls back to JSON-ish literal coercion.
export function coerceArgValue(text, expectedType) {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  switch (expectedType) {
    case "string":
      return text;
    case "number":
    case "integer": {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case "boolean":
      if (text.trim() === "true") return true;
      if (text.trim() === "false") return false;
      return text;
    default:
      return coerceLiteral(text);
  }
}

// The text shown in a value input for a stored value (the inverse of coerceArgValue).
export function argValueText(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  return String(value);
}

// ---- immutable row editing --------------------------------------------------
export function addArgRow(rows) {
  return [...(rows || []), emptyArgRow()];
}

export function removeArgRow(rows, index) {
  return (rows || []).filter((_, i) => i !== index);
}

export function updateArgRow(rows, index, patch) {
  return (rows || []).map((r, i) => (i === index ? { ...r, ...patch } : r));
}
