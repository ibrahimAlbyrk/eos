// MEMORY.md is the per-project memory index Claude loads into context each
// session — one markdown line per memory file: "- [Title](slug.md) — hook".
// When the UI removes a memory we drop its line here, never reformatting the
// rest, so a human's (or Claude's) curation of the file is preserved.

// Drop every line that links to <name>.md. Matching the link token (not the
// title) is stable regardless of how the line was originally worded.
export function removeFromIndex(indexText: string, name: string): string {
  const token = `](${name}.md)`;
  return indexText
    .split("\n")
    .filter((line) => !line.includes(token))
    .join("\n");
}
