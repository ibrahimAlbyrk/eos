// PromptSource — where prompt templates come from. The adapter (FilePromptSource)
// reads files and parses YAML frontmatter; core stays oblivious to storage and
// on-disk format.

import type { RawPrompt } from "../domain/prompt.ts";

export interface PromptSource {
  // All prompts, read fresh. Later-listed entries override earlier ones by id
  // (user prompts shadow built-ins).
  list(): RawPrompt[];
}
