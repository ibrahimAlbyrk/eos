const ORCH_NAME_ADJECTIVES = [
  "swift", "brave", "calm", "bright", "sharp", "quiet", "bold", "kind",
  "wise", "neat", "cool", "warm", "fast", "deep", "soft", "lone",
  "spry", "vivid", "keen", "merry", "lucky", "fair", "tidy", "nimble",
];

export function randomOrchestratorName(): string {
  const adj = ORCH_NAME_ADJECTIVES[Math.floor(Math.random() * ORCH_NAME_ADJECTIVES.length)];
  const n = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${adj}-${n}-orchestrator`;
}
