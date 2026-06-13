// Join rendered fragments into the final system prompt. Each fragment is
// trimmed and empty ones dropped, then joined by a blank line so sections read
// as distinct blocks. Deterministic — order is decided upstream by
// selectFragments.

export function composePrompt(rendered: string[]): string {
  const blocks = rendered.map((s) => s.trim()).filter((s) => s.length > 0);
  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}
