// Drop the memory docs whose source is loaded natively by this backend kind
// (assumeNativeFor → MemoryDoc.nativeFor), so Eos never injects a backend's own
// memory twice. The claude-cli binary auto-loads CLAUDE.md, so the "claude" source
// carries nativeFor:["claude-cli"] and is filtered out for that lane; the
// claude-sdk lane loads nothing itself, so everything is injectable. Pure.

import type { MemorySnapshot } from "../ports/MemoryProvider.ts";

export function selectInjectableMemory(snapshot: MemorySnapshot, backendKind: string): MemorySnapshot {
  return { docs: snapshot.docs.filter((d) => !d.nativeFor.includes(backendKind)) };
}
