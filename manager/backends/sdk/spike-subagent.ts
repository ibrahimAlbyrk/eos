// SPIKE (manual, not a test) — reproduces the orchestrator subagent pattern and
// verifies the premature-close bug + the real per-agent close signal.
//
//   cd manager && npx tsx backends/sdk/spike-subagent.ts
//
// Launches TWO subagents (the orchestrator pattern: concurrent / interleaved) and
// captures BOTH layers:
//   • [RAW]  — the real SDK message stream (parent=- top-level, parent=<id> subagent
//              internals). Shows whether a top-level tool_result for the agent's own
//              id ("step-5") exists and WHEN, per agent.
//   • [CANON]— what SdkEventMapper emits (incl. my synth-close). A close
//              (message role:tool) for agent X followed by activity parentCallId=X
//              means X was closed WHILE STILL RUNNING → the premature-close bug. A
//              close with content len=0 is my synthesized close (not the real result).
//
// Real, subscription-billed turn. Prereq: logged into Claude (or `claude setup-token`).

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkBackend, type SdkQueryFn } from "./ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// --- RAW layer: ground truth of the SDK stream -----------------------------
const toolNameById = new Map<string, string>();
const topToolUseIds = new Set<string>();
const rawParentIds = new Set<string>();
const topResultIds = new Set<string>();

function dumpRaw(msg: unknown): void {
  const m = (msg ?? {}) as Rec;
  const parent = str(m.parent_tool_use_id);
  if (parent) rawParentIds.add(parent);
  const content = (m.message as Rec | undefined)?.content;
  let detail = "";
  if (Array.isArray(content)) {
    detail = (content as Rec[]).map((b) => {
      if (b.type === "tool_use") {
        const id = str(b.id) ?? "";
        toolNameById.set(id, str(b.name) ?? "?");
        if (!parent) topToolUseIds.add(id);
        return `tool_use(${str(b.name)}#${id.slice(-6)})`;
      }
      if (b.type === "tool_result") {
        const id = str(b.tool_use_id) ?? "";
        if (!parent && id) topResultIds.add(id);
        return `tool_result(#${id.slice(-6)}${b.is_error ? " ERR" : ""})`;
      }
      if (b.type === "text") return `text("${(str(b.text) ?? "").slice(0, 30)}…")`;
      if (b.type === "thinking") return "thinking";
      return String(b.type);
    }).join(", ");
  } else if (typeof content === "string") {
    detail = `str("${content.slice(0, 30)}…")`;
  } else if (m.event) {
    detail = `stream:${str((m.event as Rec).type)}`;
  }
  console.log(`[RAW] type=${str(m.type)}${m.subtype ? `/${str(m.subtype)}` : ""} parent=${parent ? parent.slice(-6) : "-"} :: ${detail}`);
}

const loggingQuery: SdkQueryFn = (params) => {
  const q = realQuery(params as never) as AsyncIterable<unknown> & { interrupt?: () => Promise<void> };
  const wrapped = (async function* () {
    for await (const msg of q) { dumpRaw(msg); yield msg; }
  })() as AsyncGenerator<unknown> & { interrupt?: () => Promise<void> };
  wrapped.interrupt = q.interrupt?.bind(q);
  return wrapped as never;
};

// --- CANON layer: what the mapper emits (incl. synth-close) -----------------
interface CanonRow { i: number; kind: string; callId?: string; parent?: string; len?: number; name?: string }
const canon: CanonRow[] = [];
let ci = 0;
function recordCanon(e: AgentEvent): void {
  if (e.type === "message" && e.role === "assistant") {
    for (const b of e.blocks) if (b.type === "tool_call") canon.push({ i: ci++, kind: "call", callId: b.callId, name: b.name });
  } else if (e.type === "message" && e.role === "tool") {
    for (const b of e.blocks) if (b.type === "tool_result") canon.push({ i: ci++, kind: "close", callId: b.callId, len: (b.content ?? "").length });
  } else if (e.type === "activity") {
    canon.push({ i: ci++, kind: e.kind, callId: e.callId ?? undefined, parent: e.parentCallId ?? undefined });
  } else if (e.type === "turn") {
    canon.push({ i: ci++, kind: `turn:${e.phase}` });
  }
}

const be = createClaudeSdkBackend({
  authResolver: createSubscriptionAuthResolver(),
  policy: { decide: async () => ({ behavior: "allow" }) },
  toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
  daemonUrl: "http://127.0.0.1:7400",
  makeToolContext: (sp) => ({ selfId: sp.workerId, cwd: sp.cwd, isGitRepo: () => false, api: async () => ({}) }),
  queryFn: loggingQuery,
});

let resolveExit: () => void = () => {};
const exited = new Promise<void>((r) => { resolveExit = r; });
const session = await be.start(
  {
    workerId: "spike-sub-2",
    cwd: process.cwd(),
    model: "claude-opus-4-8",
    prompt: "Use the Task tool to launch TWO general-purpose subagents IN PARALLEL in a single step (one message with two Task calls). Subagent A: run the bash command `ls` and report how many entries it lists. Subagent B: run `pwd` and report the directory. Wait for BOTH to finish, then reply with both results in one sentence.",
    persistent: false,
    parentId: null,
    isOrchestrator: false,
    backendOptions: { auth: { kind: "subscription" } },
  },
  {
    onEvent: (e: AgentEvent) => {
      recordCanon(e);
      if (e.type === "turn" && (e.phase === "ended" || e.phase === "error")) session.stop();
    },
    onExit: () => resolveExit(),
  },
);
await exited;

// --- analysis ---------------------------------------------------------------
const agents = [...topToolUseIds].filter((id) => rawParentIds.has(id));

console.log("\n=== CANON trace (what the mapper emitted) ===");
for (const r of canon) {
  const tag = r.kind === "call" ? `call(${r.name}#${(r.callId ?? "").slice(-6)})`
    : r.kind === "close" ? `CLOSE(#${(r.callId ?? "").slice(-6)} len=${r.len})`
    : r.kind.startsWith("turn") ? r.kind
    : `${r.kind}(call=${(r.callId ?? "-").slice(-6)} parent=${(r.parent ?? "-").slice(-6)})`;
  console.log(`[CANON#${r.i}] ${tag}`);
}

console.log("\n=== SUBAGENT SPIKE SUMMARY ===");
if (agents.length === 0) {
  console.log("No subagent spawned. The model may have worked inline — rerun or strengthen the prompt.");
} else {
  for (const id of agents) {
    const name = toolNameById.get(id) ?? "?";
    const step5 = topResultIds.has(id);
    const close = canon.find((r) => r.kind === "close" && r.callId === id);
    const lastParentedI = canon.filter((r) => r.parent === id).reduce((mx, r) => Math.max(mx, r.i), -1);
    const premature = !!close && lastParentedI > close.i;
    const verdict = !close ? "never closed in CANON"
      : premature ? `*** PREMATURE: closed at CANON#${close.i} (len=${close.len}${close.len === 0 ? ", SYNTH" : ""}) but parented activity continued to CANON#${lastParentedI} ***`
      : `closed at CANON#${close.i} (len=${close.len}${close.len === 0 ? ", SYNTH" : ""}) after its last parented activity (CANON#${lastParentedI}) — OK`;
    console.log(`agent ${name}#${id.slice(-6)}: RAW step-5(top-level tool_result)=${step5 ? "YES" : "NO"} | ${verdict}`);
  }
}
console.log("\nKey: a PREMATURE line = the agentRun was marked completed while the subagent was still running (the bug).");
console.log("len=0 SYNTH close = my flushOpenAgents heuristic fired. A non-zero close = the real step-5 result.");
process.exit(0);
