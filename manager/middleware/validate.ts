// Validate a request body against a zod schema. Throws ValidationError on
// failure so the central error handler maps it to 400.

import type { ZodTypeAny, z } from "zod";
import { ValidationError } from "../../core/src/errors/index.ts";

export function validate<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const flat = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ValidationError(`invalid request: ${flat}`);
  }
  return r.data;
}
