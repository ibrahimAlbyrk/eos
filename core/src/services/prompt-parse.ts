// Validate a raw prompt's frontmatter (zod) and compile its body to an AST.
// Throws ValidationError on bad frontmatter — the registry catches and skips so
// one broken file never takes the daemon down.

import { PromptFrontmatterSchema } from "../../../contracts/src/prompt.ts";
import { ValidationError } from "../errors/index.ts";
import type { ParsedPrompt, RawPrompt } from "../domain/prompt.ts";
import { parseTemplate } from "./template-engine.ts";

export function parsePrompt(raw: RawPrompt): ParsedPrompt {
  const result = PromptFrontmatterSchema.safeParse(raw.frontmatter ?? {});
  if (!result.success) {
    throw new ValidationError(`invalid frontmatter for prompt "${raw.id}": ${result.error.message}`);
  }
  const frontmatter = result.data;
  const { nodes, referenced } = parseTemplate(raw.body);

  const declared = new Set(frontmatter.variables);
  const warnings: string[] = [];
  for (const name of frontmatter.variables) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) warnings.push(`variable "${name}" should be UPPER_SNAKE_CASE`);
  }
  for (const name of referenced) {
    if (!declared.has(name)) warnings.push(`variable "${name}" is used but not declared`);
  }

  return { id: raw.id, frontmatter, body: raw.body, nodes, referenced, warnings };
}
