// Prompt introspection routes — catalog + DPI assembly preview. Read-only and
// off the live spawn path: a tool to inspect exactly what the assembler would
// produce for a given spawn scenario before (and after) the cutover.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { PromptPreviewRequestSchema } from "../../contracts/src/http.ts";
import { assembleSystemPrompt } from "../../core/src/use-cases/AssembleSystemPrompt.ts";

export function registerPromptRoutes(r: Router, c: Container): void {
  // Catalog — every prompt in the library with its DPI metadata.
  r.get("/api/prompts", ({ res }) => {
    c.promptRegistry.reload();
    const prompts = c.promptRegistry.list().map((p) => ({
      id: p.id,
      description: p.frontmatter.description ?? null,
      layer: p.frontmatter.dpi?.layer ?? null,
      priority: p.frontmatter.dpi?.priority ?? null,
      conditional: Boolean(p.frontmatter.dpi?.when),
      variables: p.frontmatter.variables,
    }));
    writeJson(res, 200, { prompts });
  });

  // Preview — assemble the system prompt for a hypothetical spawn and report the
  // resolved facts + which fragments were included. Body defaults to a plain
  // worker; override any field to explore a scenario.
  r.post("/api/prompts/preview", async ({ req, res }) => {
    const body = validate(PromptPreviewRequestSchema, await readBody(req));
    const result = await assembleSystemPrompt(
      { factProviders: [], registry: c.promptRegistry, prompts: c.prompts },
      body,
    );
    writeJson(res, 200, result);
  });
}
