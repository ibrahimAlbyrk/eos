// `eos prompts validate` — static check of the prompt library: frontmatter
// shape, template well-formedness (the strict parser throws on malformed
// tokens/blocks), declared-variable warnings, and DPI condition validity.
// Authoring-time safety net; needs no daemon. Exit 1 on any error.

import { join } from "node:path";
import type { Command } from "./Command.ts";
import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { parsePrompt } from "../../../core/src/services/prompt-parse.ts";
import { DpiMetaSchema } from "../../../contracts/src/prompt.ts";
import { errMsg } from "../../../contracts/src/util.ts";

export const promptsCommand: Command = {
  name: "prompts",
  description: "Validate the prompt library (frontmatter, templates, variables, DPI conditions)",
  usage: "eos prompts validate",
  async run(args, ctx): Promise<void> {
    if (args[0] !== "validate") {
      console.log("usage: eos prompts validate");
      process.exit(1);
    }
    const dirs = [ctx.config.paths.promptsDir, join(ctx.config.daemon.home, "prompts")];
    const raws = new FilePromptSource(dirs).list().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let errors = 0;
    let warnings = 0;
    for (const raw of raws) {
      const problems: string[] = [];
      try {
        const parsed = parsePrompt(raw);
        for (const w of parsed.warnings) {
          problems.push(`warn:  ${w}`);
          warnings++;
        }
        const dpi = parsed.frontmatter.dpi;
        if (dpi !== undefined && dpi !== null) {
          const r = DpiMetaSchema.safeParse(dpi);
          if (!r.success) {
            problems.push(`error: invalid dpi — ${r.error.issues.map((i) => i.message).join("; ")}`);
            errors++;
          }
        }
      } catch (e) {
        problems.push(`error: ${errMsg(e)}`);
        errors++;
      }

      const hasError = problems.some((p) => p.startsWith("error"));
      console.log(`  ${problems.length === 0 ? "✓" : hasError ? "✗" : "⚠"} ${raw.id}`);
      for (const p of problems) console.log(`      ${p}`);
    }

    console.log(`\n${raws.length} prompts — ${errors} error(s), ${warnings} warning(s)`);
    process.exit(errors > 0 ? 1 : 0);
  },
};
