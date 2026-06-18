// Fold project/user memory (CLAUDE.md, AGENTS.md, …) into the DPI-assembled
// append text for backends that do not load it natively. Pure and separate from
// AssembleSystemPrompt so the DPI text stays backend-neutral and the memory
// section is testable in isolation. Docs are grouped under their source's label;
// the Eos orchestration role comes first, memory follows. With no memory the DPI
// text is returned VERBATIM (null stays null) — backends without injected memory
// are byte-for-byte unchanged.

import type { MemorySnapshot } from "../ports/MemoryProvider.ts";

export function composeMemorySection(snapshot: MemorySnapshot): string {
  const order: string[] = [];
  const bySource = new Map<string, { label: string; blocks: string[] }>();
  for (const d of snapshot.docs) {
    if (!d.content.trim()) continue;
    let group = bySource.get(d.sourceId);
    if (!group) {
      group = { label: d.sourceLabel, blocks: [] };
      bySource.set(d.sourceId, group);
      order.push(d.sourceId);
    }
    group.blocks.push(`### ${d.path}\n\n${d.content.trim()}`);
  }
  const sections = order
    .map((id) => bySource.get(id)!)
    .filter((g) => g.blocks.length)
    .map((g) => `## ${g.label}\n\n${g.blocks.join("\n\n")}`);
  return sections.length ? `# Project & user instructions\n\n${sections.join("\n\n")}` : "";
}

export function composeAppendedPrompt(dpiText: string | null, memory: MemorySnapshot | null): string | null {
  const memorySection = memory ? composeMemorySection(memory) : "";
  if (!memorySection) return dpiText;
  if (!dpiText || !dpiText.trim()) return memorySection;
  return `${dpiText}\n\n${memorySection}`;
}
