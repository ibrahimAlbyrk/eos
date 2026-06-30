import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { structuredOutputEnvelope, lcdJsonSchema } from "../backends/structured-output.ts";

// Structured output: one portable JSON Schema, a different REQUEST WRAPPER per
// provider, selected by capabilities.structuredOutput (06 §4.2). The schema is
// reduced to a lowest-common-denominator the weakest engines accept.

describe("lcdJsonSchema", () => {
  it("keeps the portable core and strips $ref/constraints/recursion-ish keywords", () => {
    const out = lcdJsonSchema({
      type: "object",
      properties: {
        n: { type: "number", minimum: 0, maximum: 10 },
        s: { type: "string", minLength: 1, pattern: "^a", format: "email" },
        ref: { $ref: "#/$defs/x" },
      },
      required: ["n"],
      $defs: { x: { type: "string" } },
      additionalProperties: true,
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.n.type, "number");
    assert.equal("minimum" in props.n, false);
    assert.equal("maximum" in props.n, false);
    assert.equal("minLength" in props.s, false);
    assert.equal("pattern" in props.s, false);
    assert.equal("format" in props.s, false);
    assert.deepEqual(props.ref, {}, "$ref has no portable keyword → unconstrained schema");
    assert.deepEqual(out.required, ["n"]);
    assert.equal("$defs" in out, false);
    assert.equal(out.additionalProperties, false, "object schemas get additionalProperties:false");
  });

  it("recurses into items and caps pathological depth", () => {
    const out = lcdJsonSchema({ type: "array", items: { type: "object", properties: { v: { type: "string", maxLength: 3 } } } });
    const items = out.items as { type: string; properties: Record<string, Record<string, unknown>> };
    assert.equal(items.type, "object");
    assert.equal("maxLength" in items.properties.v, false);
  });
});

describe("structuredOutputEnvelope", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

  it("returns {} for 'none' or a missing request (default path unchanged)", () => {
    assert.deepEqual(structuredOutputEnvelope("none", { schema }), {});
    assert.deepEqual(structuredOutputEnvelope("openai-response_format", undefined), {});
    assert.deepEqual(structuredOutputEnvelope(undefined, { schema }), {});
  });

  it("openai-response_format → response_format.json_schema(strict)", () => {
    const env = structuredOutputEnvelope("openai-response_format", { name: "r", schema }) as { response_format: { type: string; json_schema: { name: string; strict: boolean } } };
    assert.equal(env.response_format.type, "json_schema");
    assert.equal(env.response_format.json_schema.name, "r");
    assert.equal(env.response_format.json_schema.strict, true);
  });

  it("anthropic-output_config → output_config.format", () => {
    const env = structuredOutputEnvelope("anthropic-output_config", { schema }) as { output_config: { format: { type: string } } };
    assert.equal(env.output_config.format.type, "json_schema");
  });

  it("vllm-guided_json → guided_json (the raw schema)", () => {
    const env = structuredOutputEnvelope("vllm-guided_json", { schema }) as { guided_json: { type: string } };
    assert.equal(env.guided_json.type, "object");
  });

  it("ollama-format → format (the raw schema)", () => {
    const env = structuredOutputEnvelope("ollama-format", { schema }) as { format: { type: string } };
    assert.equal(env.format.type, "object");
  });

  it("sanitizes an unsafe response name to a default", () => {
    const env = structuredOutputEnvelope("openai-response_format", { name: "bad name!", schema }) as { response_format: { json_schema: { name: string } } };
    assert.equal(env.response_format.json_schema.name, "response");
  });
});
