// Pure rows↔JSON-Schema model for the structured schema builder (the worker
// `outputSchema` + the graph-level `argsSchema`). The operator authors the common
// flat-object case as rows of { field name, type, required }; rowsToSchema compiles
// them to a JSON Schema { type:"object", properties:{…}, required:[…] }. Types come
// from a CLOSED selector (SCHEMA_FIELD_TYPES — the daemon's checkType vocabulary),
// so the builder CANNOT emit an invalid `type`.
//
// Only flat-object schemas are representable as rows. Anything advanced (a nested
// object, an array-of-objects, oneOf/$ref/enum, an annotation keyword the builder
// doesn't own) is NOT representable: it stays in the raw JSON editor and
// describeNonRepresentable says why, so switching to Form mode never silently drops
// data the rows can't carry. Kept React/DOM-free like predicateModel.js so it
// unit-tests in the node env.

import { isPlainObject } from "./jsonSchemaCheck.js";

// The leaf types a row may declare — the daemon's checkType + nullability tokens
// (jsonSchemaCheck SCHEMA_TYPES), surfaced as a selector.
export const SCHEMA_FIELD_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

// The only top-level keywords the flat-object builder owns. A schema carrying any
// other keyword is advanced (left raw, so the builder can't drop it).
const OWNED_SCHEMA_KEYS = ["type", "properties", "required"];

export function emptyRow() {
  return { name: "", type: "string", required: false };
}

// A property is representable iff it is a plain object whose ONLY keyword is a
// scalar `type` from the vocab — i.e. a bare leaf the rows can carry losslessly.
// A property with items/properties/enum/$ref/description/etc. is advanced.
function isRepresentableProperty(sub) {
  if (!isPlainObject(sub)) return false;
  const keys = Object.keys(sub);
  return keys.length === 1 && keys[0] === "type" && typeof sub.type === "string" && SCHEMA_FIELD_TYPES.includes(sub.type);
}

export function isRepresentableSchema(value) {
  if (value === undefined) return true; // empty → zero rows
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).some((k) => !OWNED_SCHEMA_KEYS.includes(k))) return false;
  if (value.type !== undefined && value.type !== "object") return false;
  if (value.properties !== undefined) {
    if (!isPlainObject(value.properties)) return false;
    if (!Object.values(value.properties).every(isRepresentableProperty)) return false;
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((k) => typeof k !== "string"))) {
    return false;
  }
  return true;
}

function stringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Why a value can't be a row builder — a short operator-facing reason, or null when
// it IS representable. Used to label the locked raw-JSON editor.
export function describeNonRepresentable(value) {
  if (isRepresentableSchema(value)) return null;
  if (!isPlainObject(value)) return "schema is not a JSON object";
  if (value.type !== undefined && value.type !== "object") {
    return `top-level type ${stringify(value.type)} — the row builder authors object schemas only`;
  }
  for (const k of ["oneOf", "anyOf", "allOf", "not", "if", "$ref", "$defs", "definitions"]) {
    if (k in value) return `uses "${k}"`;
  }
  if (isPlainObject(value.properties)) {
    for (const [name, sub] of Object.entries(value.properties)) {
      if (!isRepresentableProperty(sub)) return `field "${name}" has a nested or constrained schema`;
    }
  }
  const extra = Object.keys(value).filter((k) => !OWNED_SCHEMA_KEYS.includes(k));
  if (extra.length) return `uses keyword "${extra[0]}"`;
  return "uses advanced JSON-Schema constructs";
}

// Parse a representable schema into builder rows (the inverse of rowsToSchema). A
// non-representable / empty value yields no rows.
export function schemaToRows(value) {
  if (!isRepresentableSchema(value) || !isPlainObject(value)) return [];
  const props = isPlainObject(value.properties) ? value.properties : {};
  const required = Array.isArray(value.required) ? value.required : [];
  return Object.entries(props).map(([name, sub]) => ({ name, type: sub.type, required: required.includes(name) }));
}

// Compile rows to a JSON Schema. Empty / all-unnamed rows ⇒ undefined (the field is
// omitted, matching the optionality of the raw editor). Types are clamped to the
// vocab so the emitted schema is always well-formed.
export function rowsToSchema(rows) {
  const named = (rows || []).filter((r) => r && typeof r.name === "string" && r.name.trim() !== "");
  if (named.length === 0) return undefined;
  const properties = {};
  const required = [];
  for (const r of named) {
    const key = r.name.trim();
    properties[key] = { type: SCHEMA_FIELD_TYPES.includes(r.type) ? r.type : "string" };
    if (r.required) required.push(key);
  }
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

// ---- immutable row editing --------------------------------------------------
export function addRow(rows) {
  return [...(rows || []), emptyRow()];
}

export function removeRow(rows, index) {
  return (rows || []).filter((_, i) => i !== index);
}

export function updateRow(rows, index, patch) {
  return (rows || []).map((r, i) => (i === index ? { ...r, ...patch } : r));
}
