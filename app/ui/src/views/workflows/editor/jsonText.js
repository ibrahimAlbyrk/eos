// Pure parse / validate / format for the JSON text fields the inspector edits
// through CodeMirror: a worker `outputSchema`, the graph `argsSchema`, a port
// `schema` (JSON-Schema fields) and `init` / `subGraph.args` (free JSON literals).
// The CodeMirror component is the view; this is the tested logic it drives. Kept
// React/DOM-free like graphModel.js / predicateModel.js.

import { metaValidateSchema } from "./jsonSchemaCheck.js";

// Parse a JSON text field. Empty / whitespace ⇒ { ok, value: undefined } so the
// field is omitted from config (matches v1 optionality). Returns the parsed value
// or a human error message — never throws.
export function parseJson(text) {
  if (text == null || String(text).trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Validate a JSON-Schema field: must parse, be a plain object, AND be structurally
// well-formed per the daemon's recognized vocabulary (metaValidateSchema mirrors
// compileJsonSchema). This catches the wrong-but-valid schemas the daemon would
// silently no-op at run time — a bad `type` value, a misspelled core keyword — so
// they're flagged at edit time instead of binding raw data downstream.
export function validateJsonSchema(text) {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return parsed; // optional — empty is fine
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, error: "a JSON Schema must be an object" };
  }
  const metaErrors = metaValidateSchema(parsed.value);
  if (metaErrors.length) return { ok: false, error: metaErrors.join("; ") };
  return parsed;
}

// Pretty-print a stored value back into the editor (undefined ⇒ empty string).
export function formatJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}
