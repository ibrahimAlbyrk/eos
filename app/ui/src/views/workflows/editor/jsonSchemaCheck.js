// Edit-time mirror of the daemon's JSON-Schema subset
// (manager/services/json-schema-validator.ts → compileJsonSchema). Two pure
// functions, so the editor and the run time agree by construction:
//
//   validateValue(schema, value)  — does VALUE satisfy SCHEMA? A faithful port of
//     the daemon's `validate`: same type vocabulary, same keywords
//     (object/array/string/number/integer/boolean, enum, required/properties,
//     items, nullable), permissive on anything outside the subset. Used to flag
//     subGraph args that don't match the target workflow's argsSchema.
//
//   metaValidateSchema(schema)    — is SCHEMA ITSELF well-formed? The daemon
//     compiles any object permissively and silently no-ops what it can't read, so
//     a wrong-but-valid schema (a bad `type` value, a misspelled core keyword like
//     "typ") commits clean and only fails to constrain at run time. This flags
//     those at edit time, using the SAME vocabulary the daemon reads — it never
//     rejects a construct the daemon would honor.
//
// Kept React/DOM-free like jsonText.js so it unit-tests in the node env.

// The type tokens the daemon's checkType + nullability handling recognize.
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

// The keywords the daemon actually reads from a schema.
const CONSTRAINT_KEYWORDS = ["type", "properties", "required", "items", "enum", "nullable"];

// Standard JSON-Schema keywords the daemon ignores but are legitimate to write
// (annotations + constraints from other drafts). Listed so meta-validation flags a
// genuinely-unknown key (a typo like "typ") without rejecting a valid keyword the
// daemon merely doesn't enforce — that would reject a schema the daemon accepts.
const TOLERATED_KEYWORDS = [
  "title", "description", "$schema", "$id", "$ref", "$defs", "$comment", "$anchor",
  "definitions", "default", "examples", "const", "format", "readOnly", "writeOnly", "deprecated",
  "additionalProperties", "patternProperties", "propertyNames", "minProperties", "maxProperties",
  "unevaluatedProperties", "dependentRequired", "dependentSchemas", "dependencies",
  "additionalItems", "prefixItems", "contains", "minContains", "maxContains", "minItems", "maxItems", "uniqueItems",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern",
  "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
  "contentEncoding", "contentMediaType", "unevaluatedItems",
];
const KNOWN_KEYWORDS = new Set([...CONSTRAINT_KEYWORDS, ...TOLERATED_KEYWORDS]);

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asSchema(schema) {
  return isPlainObject(schema) ? schema : null;
}

function kindOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function label(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---- validateValue — VALUE against SCHEMA (mirror of the daemon's `validate`) ----

function typesOf(schema) {
  const raw = schema.type;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const types = list.filter((t) => typeof t === "string" && t !== "null");
  const nullable = schema.nullable === true || (Array.isArray(raw) && raw.includes("null"));
  return { types, nullable };
}

function checkType(type, value, path) {
  switch (type) {
    case "object": return isPlainObject(value) ? null : `${path}: expected object, got ${kindOf(value)}`;
    case "array": return Array.isArray(value) ? null : `${path}: expected array, got ${kindOf(value)}`;
    case "string": return typeof value === "string" ? null : `${path}: expected string, got ${kindOf(value)}`;
    case "boolean": return typeof value === "boolean" ? null : `${path}: expected boolean, got ${kindOf(value)}`;
    case "number": return typeof value === "number" && Number.isFinite(value) ? null : `${path}: expected number, got ${kindOf(value)}`;
    case "integer": return typeof value === "number" && Number.isInteger(value) ? null : `${path}: expected integer, got ${kindOf(value)}`;
    default: return null; // unknown type keyword → permissive (matches the daemon)
  }
}

function validateObject(schema, value, path) {
  const errors = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && value[key] === undefined) errors.push(`${path}.${key}: required field missing`);
  }
  const properties = asSchema(schema.properties);
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) errors.push(...validateValue(propSchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

export function validateValue(schemaRaw, value, path = "value") {
  const schema = asSchema(schemaRaw);
  if (!schema) return []; // not a schema object → nothing to enforce

  const { types, nullable } = typesOf(schema);
  if (value === null) return nullable ? [] : (types.length ? [`${path}: expected ${types.join("|")}, got null`] : []);

  const errors = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: ${label(value)} is not one of the allowed values`);
  }
  for (const type of types) {
    const typeError = checkType(type, value, path);
    if (typeError) errors.push(typeError);
  }
  if (types.includes("object") && isPlainObject(value)) errors.push(...validateObject(schema, value, path));
  if (types.includes("array") && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => errors.push(...validateValue(schema.items, item, `${path}[${i}]`)));
  }
  return errors;
}

// ---- metaValidateSchema — is the SCHEMA itself well-formed? -------------------
// Returns [] for a sound schema, else human messages. Walks only the keywords the
// daemon reads (type/properties/items + their value-shapes), recursing the same
// structures the daemon traverses, so it never flags what the daemon would honor.

export function metaValidateSchema(schemaRaw, path = "schema") {
  const schema = asSchema(schemaRaw);
  if (!schema) return [`${path}: a JSON Schema must be an object`];

  const errors = [];

  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) errors.push(`${path}: unknown schema keyword "${key}"`);
  }

  if (schema.type !== undefined) {
    const tokens = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of tokens) {
      if (typeof t !== "string" || !SCHEMA_TYPES.includes(t)) {
        errors.push(`${path}.type: ${label(t)} is not a valid type (expected one of ${SCHEMA_TYPES.join(", ")})`);
      }
    }
  }

  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== "string"))) {
    errors.push(`${path}.required: must be an array of property-name strings`);
  }

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    errors.push(`${path}.enum: must be a non-empty array`);
  }

  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    errors.push(`${path}.nullable: must be true or false`);
  }

  if (schema.properties !== undefined) {
    const props = asSchema(schema.properties);
    if (!props) errors.push(`${path}.properties: must be an object of subschemas`);
    else for (const [key, sub] of Object.entries(props)) errors.push(...metaValidateSchema(sub, `${path}.properties.${key}`));
  }

  if (schema.items !== undefined) {
    if (!asSchema(schema.items)) errors.push(`${path}.items: must be a schema object`);
    else errors.push(...metaValidateSchema(schema.items, `${path}.items`));
  }

  return errors;
}
