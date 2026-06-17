// SPIKE (manual, not a test) — runs the REAL claude-sdk backend against your
// logged-in Claude subscription. Makes ONE real, subscription-billed turn.
//
//   cd manager && npx tsx backends/sdk/spike.ts
//
// The Phase-4 hard gate. It verifies, end-to-end on the TS SDK, the four things
// the design flagged as Python-proven-but-TS-unverified:
//   (a) live thinking — includePartialMessages yields thinking_delta deltas
//   (b/c) billing — the planted ANTHROPIC_API_KEY below must NOT divert billing;
//         after the run, confirm in your Anthropic usage that this turn billed
//         your SUBSCRIPTION, not the metered API pool
//   (e) ENABLE_TOOL_SEARCH=false reaches the child (custom tools load directly)
//   + the SdkEventMapper produces a sane canonical sequence from REAL messages.

import { createClaudeSdkBackend } from "./ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

// (b/c) A sentinel the billing guard MUST strip. If billing lands on the API
// pool, the guard failed (or the SDK overlays env) — that is the make-or-break finding.
process.env.ANTHROPIC_API_KEY = "sk-LEAK-SENTINEL-should-be-scrubbed";

const be = createClaudeSdkBackend({
  authResolver: createSubscriptionAuthResolver(),
  policy: { decide: async () => ({ behavior: "allow" }) },
  toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescription: (n) => n },
  daemonUrl: "http://127.0.0.1:7400",
  makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
});

let reasoningDeltas = 0;
let textDeltas = 0;
const seen = new Set<string>();
let lastChannel = "";

await new Promise<void>((res) => {
  be.start(
    {
      workerId: "spike-1",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      prompt: "ultrathink: prove there are infinitely many primes, briefly. Reason first.",
      persistent: false,
      parentId: null,
      isOrchestrator: false,
      backendOptions: { auth: { kind: "subscription" }, thinking: { type: "adaptive", display: "summarized" } },
    },
    {
      onEvent: (e: AgentEvent) => {
        seen.add(e.type);
        if (e.type === "delta") {
          if (e.channel === "reasoning") reasoningDeltas++;
          else textDeltas++;
          if (e.channel !== lastChannel) { process.stdout.write(`\n\n[${e.channel}] `); lastChannel = e.channel; }
          process.stdout.write(e.text);
        }
      },
      onExit: () => res(),
    },
  );
});

console.log("\n\n=== SPIKE RESULTS ===");
console.log("event types seen:", [...seen].join(", "));
console.log("(a) live thinking streams:", reasoningDeltas > 0 ? `YES (${reasoningDeltas} reasoning deltas)` : "NO");
console.log("    text deltas:", textDeltas);
console.log("(b/c) NEXT — confirm in your Anthropic usage dashboard that this turn billed your");
console.log("      SUBSCRIPTION, not the API pool (the planted ANTHROPIC_API_KEY must have been scrubbed).");
console.log("(e) if a custom tool was offered and loaded without a ToolSearch step, ENABLE_TOOL_SEARCH=false held.");
process.exit(0);
