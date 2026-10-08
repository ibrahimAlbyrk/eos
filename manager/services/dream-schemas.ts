// The JSON Schemas of the dream's four structured answers, built from the
// contracts' zod schemas — one place for the daemon and scripts/dream-eval.

import { zodToJsonSchema } from "zod-to-json-schema";
import {
  DreamConsolidateOutputSchema, DreamCriticOutputSchema, DreamMatchOutputSchema, DreamRecallOutputSchema,
} from "../../contracts/src/dream.ts";

const jsonSchema = (schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> =>
  zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;

export const DREAM_SCHEMAS = {
  recall: jsonSchema(DreamRecallOutputSchema),
  match: jsonSchema(DreamMatchOutputSchema),
  consolidate: jsonSchema(DreamConsolidateOutputSchema),
  critic: jsonSchema(DreamCriticOutputSchema),
};
