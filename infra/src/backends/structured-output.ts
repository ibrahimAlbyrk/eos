// Structured-output normalization (M4). JSON Schema is the portable core; the
// REQUEST WRAPPER differs per provider, so it is driven by the declared
// capabilities.structuredOutput value, never a model-name heuristic. The two model
// clients merge the returned fragment into the request body when (and only when) a
// caller supplies a responseFormat — so the default (no structured output) path is
// unchanged.

import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

type Json = Record<string, unknown>;

// A conservative lowest-common-denominator JSON Schema: strip the constructs the
// weakest engines reject ($ref/recursion, numeric/string constraints, format) and
// keep the portable core (type/properties/items/required/enum/description). Cyclic
// or too-deep schemas degrade to a bare object rather than recursing forever.
const PORTABLE_KEYS = new Set(["type", "properties", "items", "required", "enum", "description"]);

export function lcdJsonSchema(schema: unknown, depth = 0): Json {
  if (depth > 8 || schema === null || typeof schema !== "object") return { type: "object" };
  const src = schema as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(src)) {
    if (!PORTABLE_KEYS.has(k)) continue; // drops $ref/$defs/allOf/min*/max*/pattern/format/multipleOf/…
    if (k === "properties" && v && typeof v === "object") {
      const props: Json = {};
      for (const [pk, pv] of Object.entries(v as Json)) props[pk] = lcdJsonSchema(pv, depth + 1);
      out.properties = props;
    } else if (k === "items") {
      out.items = lcdJsonSchema(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  // additionalProperties:false makes OpenAI strict json_schema happy and is harmless
  // elsewhere; only stamp it on object schemas.
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

export interface StructuredRequest {
  name?: string;
  schema: Json;
}

// The provider-specific request fragment to spread into the body. Empty object for
// "none" (or no schema) so callers can always spread it unconditionally.
export function structuredOutputEnvelope(
  mode: ProviderCapabilities["structuredOutput"] | undefined,
  req: StructuredRequest | undefined,
): Json {
  if (!req || !mode || mode === "none") return {};
  const schema = lcdJsonSchema(req.schema);
  const name = req.name && /^[a-zA-Z0-9_-]+$/.test(req.name) ? req.name : "response";
  switch (mode) {
    case "openai-response_format":
      return { response_format: { type: "json_schema", json_schema: { name, schema, strict: true } } };
    case "anthropic-output_config":
      // NOTE (m4): DORMANT / UNVERIFIED. Gated off by default (structuredOutput:"none")
      // and never exercised against the live Anthropic API — the exact request envelope
      // is unconfirmed and a profile enabling it may 400. Verify the real field/shape
      // before advertising it.
      return { output_config: { format: { type: "json_schema", schema } } };
    case "vllm-guided_json":
      return { guided_json: schema };
    case "ollama-format":
      return { format: schema };
    default:
      return {};
  }
}
