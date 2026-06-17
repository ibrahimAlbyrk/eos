// SPIKE (manual, not a test) — runs the REAL claude-sdk backend against your
// logged-in Claude subscription. Makes ONE real, subscription-billed turn that
// also exercises a custom in-process tool through the policy gate.
//
//   cd manager && npx tsx backends/sdk/spike.ts
//
// Prereq: you are logged into Claude (an existing Claude Code login, or run
// `claude setup-token` for a long-lived sk-ant-oat01 token). NO daemon needed —
// the tool here is self-contained (its handler returns a constant).
//
// The FLIP gate. It verifies, end-to-end on the TS SDK, every concern the design
// flagged as Python-proven-but-TS-unverified:
//   (a) live thinking — includePartialMessages yields thinking_delta deltas
//   (b/c) BILLING — the planted ANTHROPIC_API_KEY below MUST be scrubbed; the turn
//         must bill your SUBSCRIPTION, not the metered API pool (confirm in usage)
//   (d) AUTH SIGNAL — the resolved token is a long-lived sk-ant-oat01 setup-token
//   (e) ENABLE_TOOL_SEARCH=false — the custom tool loads directly (no search step)
//   (f) TOOLS + canUseTool (Step A) — the tool is offered, canUseTool→policy fires
//       for it, the handler runs, and the secret reaches the answer

import { createClaudeSdkBackend } from "./ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { ToolDefinition } from "../../tools/types.ts";

// (b/c) A sentinel the billing guard MUST strip. If billing lands on the API
// pool, the guard failed (or the SDK overlays env) — the make-or-break finding.
process.env.ANTHROPIC_API_KEY = "sk-LEAK-SENTINEL-should-be-scrubbed";

// (d) Resolve the subscription credential up front and assert the token shape —
// a long-lived setup-token (sk-ant-oat01-…), not a metered API key.
const auth = await createSubscriptionAuthResolver().resolve({ kind: "subscription" });
const tokenOk = auth.scheme === "oauth" && (auth.token ?? "").startsWith("sk-ant-oat01");

// (f) A self-contained custom tool; its handler returning proves the in-process
// tool ran. policyCalls > 0 proves canUseTool routed through Eos's policy (Step A:
// Eos tools are NOT allow-listed, so every call must hit canUseTool).
let handlerRan = false;
const secretTool: ToolDefinition = {
  name: "get_secret_code",
  visibility: "worker",
  inputSchema: {},
  handler: async () => { handlerRan = true; return "The secret code is PURPLE-FALCON-7782"; },
};

let policyCalls = 0;
const be = createClaudeSdkBackend({
  authResolver: createSubscriptionAuthResolver(),
  policy: { decide: async (i) => { policyCalls++; console.log(`  [canUseTool→policy] ${i.toolName}`); return { behavior: "allow" }; } },
  toolHost: { orchestratorDefs: [], workerDefs: [secretTool], peerDefs: [], renderDescription: (n) => n },
  daemonUrl: "http://127.0.0.1:7400",
  makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
  // Step A: the appended Eos prompt is what makes the agent USE its tools.
  assembleAppendPrompt: () => "You have a get_secret_code tool. When asked for the secret code, you MUST call it, then state the code.",
});

let reasoningDeltas = 0;
let textDeltas = 0;
let answer = "";
const seen = new Set<string>();
let lastChannel = "";

let resolveExit: () => void = () => {};
const exited = new Promise<void>((r) => { resolveExit = r; });
const session = await be.start(
  {
    workerId: "spike-1",
    cwd: process.cwd(),
    model: "claude-opus-4-8",
    prompt: "What is today's secret code? Use your get_secret_code tool to find out, then tell me.",
    persistent: false,
    parentId: null,
    isOrchestrator: false,
    backendOptions: { auth: { kind: "subscription" }, thinking: { type: "adaptive", display: "summarized" } },
  },
  {
    onEvent: (e: AgentEvent) => {
      seen.add(e.type);
      if (e.type === "delta") {
        if (e.channel === "reasoning") reasoningDeltas++; else textDeltas++;
        if (e.channel !== lastChannel) { process.stdout.write(`\n\n[${e.channel}] `); lastChannel = e.channel; }
        process.stdout.write(e.text);
      }
      if (e.type === "message" && e.role === "assistant") {
        for (const b of e.blocks) if (b.type === "text") answer += b.text;
      }
      // One-shot: end the (persistent) session after the first turn so we exit + summarize.
      if (e.type === "turn" && e.phase === "ended") session.stop();
    },
    onExit: () => resolveExit(),
  },
);
await exited;

const sawSecret = answer.includes("PURPLE-FALCON-7782");
console.log("\n\n=== SPIKE RESULTS ===");
console.log("event types seen:", [...seen].join(", "));
console.log(`(a) live thinking streams: ${reasoningDeltas > 0 ? `YES (${reasoningDeltas} reasoning deltas)` : "NO"}  | text deltas: ${textDeltas}`);
console.log(`(d) auth signal — oat01 setup-token: ${tokenOk ? "YES" : `NO (scheme=${auth.scheme}, prefix=${(auth.token ?? "").slice(0, 11) || "none"})`}`);
console.log(`(f) tool ran (handler): ${handlerRan ? "YES" : "NO"}  | canUseTool→policy fired: ${policyCalls > 0 ? `YES (${policyCalls}×)` : "NO"}  | secret in answer: ${sawSecret ? "YES" : "NO"}`);
console.log("(e) if the tool was offered + called without any ToolSearch step, ENABLE_TOOL_SEARCH=false held.");
console.log("\n(b/c) NEXT — open your Claude usage (claude.ai → Settings → Usage): this turn must");
console.log("      have billed your SUBSCRIPTION, not the API pool. The planted ANTHROPIC_API_KEY");
console.log("      proves the scrub: the turn succeeding at all (no auth error) means it was stripped.");
process.exit(0);
