// ConversationSummarizer — one tool-less completion that condenses a rendered
// transcript for context compaction. Distinct from OneShotClient (micro-tasks):
// it takes its own system prompt, runs on the compacted agent's model (the
// transcript must fit that model's window), and has a long, explicit timeout.
// Rejects on failure/timeout so the caller can keep the old session intact.

export interface SummarizeInput {
  readonly system: string;
  readonly prompt: string;
  /** Model alias of the agent being compacted; null → the adapter's default. */
  readonly model: string | null;
  readonly timeoutMs: number;
}

export interface StructuredSummarizeInput extends SummarizeInput {
  /** JSON Schema of the answer. The model hands it over through a schema-checked
   *  tool call instead of free text, so there is no reply to parse. */
  readonly schema: Record<string, unknown>;
}

export interface ConversationSummarizer {
  summarize(input: SummarizeInput): Promise<string>;
  /** The answer as data matching `schema`; rejects when none comes back. */
  summarizeStructured(input: StructuredSummarizeInput): Promise<unknown>;
}
