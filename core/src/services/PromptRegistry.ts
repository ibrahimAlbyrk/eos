// Loads + parses + caches prompts from a PromptSource. reload() re-reads from
// the source (cheap; called once per assembly so edits apply without a daemon
// restart). A prompt that fails to parse is skipped with a warning — never
// fatal (one bad file must not break every spawn).

import { NotFoundError } from "../errors/index.ts";
import type { Fragment, ParsedPrompt } from "../domain/prompt.ts";
import { toFragment } from "../domain/prompt.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
import { parsePrompt } from "./prompt-parse.ts";

export class PromptRegistry {
  private readonly source: PromptSource;
  private readonly logger: Logger;
  private cache: Map<string, ParsedPrompt> | null = null;

  constructor(source: PromptSource, logger: Logger) {
    this.source = source;
    this.logger = logger;
  }

  reload(): void {
    const next = new Map<string, ParsedPrompt>();
    for (const raw of this.source.list()) {
      try {
        next.set(raw.id, parsePrompt(raw));
      } catch (e) {
        this.logger.warn(`prompt skipped: ${raw.id}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.cache = next;
  }

  private ensure(): Map<string, ParsedPrompt> {
    if (!this.cache) this.reload();
    return this.cache as Map<string, ParsedPrompt>;
  }

  has(id: string): boolean {
    return this.ensure().has(id);
  }

  get(id: string): ParsedPrompt {
    const p = this.ensure().get(id);
    if (!p) throw new NotFoundError("prompt", id);
    return p;
  }

  list(): ParsedPrompt[] {
    return [...this.ensure().values()];
  }

  fragments(): Fragment[] {
    const out: Fragment[] = [];
    for (const p of this.ensure().values()) {
      const f = toFragment(p);
      if (f) out.push(f);
    }
    return out;
  }
}
