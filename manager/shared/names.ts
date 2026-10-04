const ORCH_NAME_ADJECTIVES = [
  "swift", "brave", "calm", "bright", "sharp", "quiet", "bold", "kind",
  "wise", "neat", "cool", "warm", "fast", "deep", "soft", "lone",
  "spry", "vivid", "keen", "merry", "lucky", "fair", "tidy", "nimble",
];

export function randomOrchestratorName(): string {
  const adj = ORCH_NAME_ADJECTIVES[Math.floor(Math.random() * ORCH_NAME_ADJECTIVES.length)];
  const n = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${adj}-${n}`;
}

const PROMPT_NAME_MAX_CHARS = 40;

// A nameless session is named after the start of its first message — far more
// recognizable in the sidebar than a random name — until auto-name replaces it
// with a distilled topic. null when the prompt has no text.
export function promptSnippetName(prompt: string): string | null {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat); // code points, so an emoji is never split
  if (chars.length <= PROMPT_NAME_MAX_CHARS) return flat;
  return `${chars.slice(0, PROMPT_NAME_MAX_CHARS).join("").trimEnd()}…`;
}
