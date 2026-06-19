// WorkerTypeSource — where worker-type definitions come from. The adapter
// (FileWorkerTypeSource) reads .eos/workers/*.md and parses YAML frontmatter;
// core stays oblivious to storage and on-disk format. Clone of PromptSource.

import type { WorkerTypeRecord } from "../../../contracts/src/worker-type.ts";

export interface WorkerTypeSource {
  // All types, read fresh. Later-listed dirs override earlier by name.
  list(): WorkerTypeRecord[];
}
