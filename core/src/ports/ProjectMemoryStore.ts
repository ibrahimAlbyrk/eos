// ProjectMemoryStore — narrow port over a project's file-based memory directory
// (~/.claude/projects/<encoded-cwd>/memory). The directory is resolved by the
// caller (manager) from the worker's project root and passed in per call, so
// the port is stateless and storage-agnostic. Raw I/O only: the MEMORY.md index
// logic lives in core/domain/memory-index and is orchestrated by the delete
// use-case, keeping any implementation substitutable.

import type { MemoryEntry } from "../../../contracts/src/http.ts";

export interface ProjectMemoryStore {
  /** Parsed metadata for every memory file in `dir` (excludes MEMORY.md and the
   *  .trash/ recovery dir). Returns [] if the directory does not exist. */
  list(dir: string): Promise<MemoryEntry[]>;
  /** Move the memory file to dir/.trash/ (recoverable). False if it was absent. */
  softDelete(dir: string, name: string): Promise<boolean>;
  /** Raw MEMORY.md text ("" if absent). */
  readIndex(dir: string): Promise<string>;
  writeIndex(dir: string, text: string): Promise<void>;
}
