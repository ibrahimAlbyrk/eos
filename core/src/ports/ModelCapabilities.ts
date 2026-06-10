// Per-model capability lookup, backed by the live model catalog.

export interface ModelCapabilities {
  /** Effort levels the model supports. Empty array = no effort support;
   * null = unknown (alias not in catalog, catalog unavailable) — callers
   * must fail open and keep the requested value. */
  effortLevelsFor(model: string): Promise<string[] | null>;
}
