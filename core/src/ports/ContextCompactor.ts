// ContextCompactor — trims a growing in-process conversation so a small-context
// model (G1 targets local 8k–32k models) compacts instead of hard-400ing once
// history approaches its window. Injected into the ToolRuntime loop deps and run
// before each model call; reads capabilities.contextWindow (declared data, never a
// model-name heuristic). Replaces M1's fail-fast guard with real compaction (M4).
//
// D8 (the binding caution): eviction MUST be at whole tool-turn / matched-PAIR
// granularity — an orphaned tool_use without its tool_result (or vice-versa) is
// itself a 400 on Anthropic. The default adapter drops the OLDEST tool turns and
// leaves a short retained summary marker (D8 default: drop-oldest, not summarize).

import type { ModelMessage } from "./ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

export interface ContextCompactor {
  // Return a (possibly trimmed) message list. A no-op (returns the input) when the
  // conversation is comfortably under the window. When over, drops oldest matched
  // tool-turns and keeps the original task + most-recent turns + a summary marker.
  compact(messages: ModelMessage[], capabilities: ProviderCapabilities): ModelMessage[];
}
