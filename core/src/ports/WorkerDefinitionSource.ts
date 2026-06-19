// WorkerDefinitionSource — where worker-definition definitions come from. The adapter
// (FileWorkerDefinitionSource) reads .eos/workers/*.md and parses YAML frontmatter;
// core stays oblivious to storage and on-disk format. Clone of PromptSource.

import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

export interface WorkerDefinitionSource {
  // All types, read fresh. Later-listed dirs override earlier by name.
  list(): WorkerDefinitionRecord[];
}
