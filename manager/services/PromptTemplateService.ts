// PromptTemplateService — generic loader/renderer for the markdown prompt
// templates in manager/prompts/ (meta-prompt format: frontmatter + Purpose/
// Variables/Instructions/Workflow/Report). Not tied to any one consumer —
// worker actions use it today; any system needing a parameterized prompt can.
// Templates are re-read on every call so edits apply without a daemon restart.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export class PromptTemplateService {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Render a template: strip frontmatter, substitute $1..$N with args. */
  render(file: string, args: string[] = []): string {
    const raw = readFileSync(join(this.dir, file), "utf8");
    let prompt = stripFrontmatter(raw).trim();
    for (let i = args.length - 1; i >= 0; i--) {
      prompt = prompt.replaceAll(`$${i + 1}`, args[i]);
    }
    return prompt;
  }
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  return text.slice(end + 5);
}
