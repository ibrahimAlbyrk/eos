import type { ProjectMemoryStore } from "../ports/ProjectMemoryStore.ts";
import { removeFromIndex } from "../domain/memory-index.ts";

// Delete a memory entry: soft-delete the file (recoverable in .trash/) and drop
// its line from MEMORY.md. Returns false if the entry did not exist.
export async function deleteProjectMemory(
  deps: { store: ProjectMemoryStore },
  dir: string,
  name: string,
): Promise<boolean> {
  const existed = await deps.store.softDelete(dir, name);
  if (!existed) return false;
  const index = await deps.store.readIndex(dir);
  await deps.store.writeIndex(dir, removeFromIndex(index, name));
  return true;
}
