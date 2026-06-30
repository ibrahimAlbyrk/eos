// Full-lifecycle integration (00-PLAN.md §9, "real localhost-stub model + a real
// system prompt + real built-ins"). The conformance double (agent-backend-conformance)
// proves the adapter SHAPE with a scripted fake model; this drives the WHOLE in-process
// lane end-to-end against a real HTTP model: the real OpenAIModelClient (over a
// localhost stub speaking OpenAI Chat Completions SSE), a real DPI-assembled system
// prompt delivered over the wire, real bare-named built-in tools that touch disk, the
// real ToolRuntime loop inside InProcessBackend, the real JsonlConversationStore for
// durability, and the real DropOldestContextCompactor in the loop. It asserts the
// canonical event sequence, a real built-in tool round-trip, persist→restart→resume,
// and near-window compaction — the four things M1–M4 cover piecemeal, now wired
// together over a real socket (the missing end-to-end glue).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInProcessBackend, type InProcessEnv } from "../../infra/src/backends/InProcessBackend.ts";
import { createOpenAIModelClient, type OpenAIToolSpec } from "../../infra/src/backends/OpenAIModelClient.ts";
import { createBuiltinToolRegistry } from "../../infra/src/tools/builtins/registry.ts";
import { createNodeToolFileSystem } from "../../infra/src/tools/NodeToolFileSystem.ts";
import { createNodeProcessRunner } from "../../infra/src/tools/NodeProcessRunner.ts";
import { JsonlConversationStore } from "../../infra/src/conversation/JsonlConversationStore.ts";
import { DropOldestContextCompactor } from "../../infra/src/conversation/DropOldestContextCompactor.ts";
import { randomIdGenerator } from "../../infra/src/id/RandomIdGenerator.ts";
import { FilePromptSource } from "../../infra/src/prompt/FilePromptSource.ts";

import { bindBuiltinTool } from "../../core/src/ports/BuiltinToolRegistry.ts";
import { PromptRegistry } from "../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../../core/src/use-cases/AssembleSystemPrompt.ts";
import type { SessionSpawnContext } from "../../core/src/use-cases/AssembleSystemPrompt.ts";
import type { Fragment } from "../../core/src/domain/prompt.ts";
import type { AgentEvent, AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";
import type { ModelMessage } from "../../core/src/ports/ModelClient.ts";
import type { RuntimeTool, ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";
import { TOOL_NAME_VARS } from "../prompt-tool-names.ts";

// ─── A localhost stub speaking OpenAI Chat Completions (streaming SSE) ───────────

interface StubReq { url: string; auth?: string; body: { stream?: boolean; messages: Array<{ role: string; content?: unknown }> } }
interface Stub { url: string; requests: StubReq[]; close(): Promise<void> }
type SseChunk = Record<string, unknown>;

async function startStub(script: (req: StubReq["body"], idx: number) => SseChunk[]): Promise<Stub> {
  const requests: StubReq[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: StubReq["body"] = { messages: [] };
      try { body = JSON.parse(raw); } catch { /* keep empty */ }
      requests.push({ url: req.url ?? "", auth: req.headers["authorization"] as string | undefined, body });
      const chunks = script(body, requests.length - 1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const ch of chunks) res.write(`data: ${JSON.stringify(ch)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const textDelta = (s: string): SseChunk => ({ choices: [{ delta: { content: s }, finish_reason: null }] });
const finish = (reason: string): SseChunk => ({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = (inTok: number, outTok: number): SseChunk => ({ choices: [], usage: { prompt_tokens: inTok, completion_tokens: outTok } });
const toolCallChunk = (id: string, name: string, args: unknown): SseChunk => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
});

// ─── Real built-ins + real capabilities + a real assembled system prompt ─────────

const builtins = createBuiltinToolRegistry({ fs: createNodeToolFileSystem(), proc: createNodeProcessRunner() });
const writeTool = builtins.get("Write")!;
const readTool = builtins.get("Read")!;
const toolSpecs: OpenAIToolSpec[] = [
  { name: writeTool.name, description: "Write a file", parameters: writeTool.schema },
  { name: readTool.name, description: "Read a file", parameters: readTool.schema },
];

const CAPS: ProviderCapabilities = {
  wire: "openai-chat", supportsStreaming: true, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "none", reasoningRoundTrip: "drop", cache: "automatic", structuredOutput: "none", contextWindow: 32768,
};
const allowGate: ToolGate = { async decide() { return { allow: true }; } };

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } } as never;
const promptsDir = join(import.meta.dirname, "..", "prompts");

// A real DPI-assembled in-process system prompt (the same glue container.ts uses for
// the "in-process" lane: the lane base fragment in `extra` over the real registry).
function realSystemPrompt(): string {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  const prompts = new PromptService(registry, TOOL_NAME_VARS);
  const extra: Fragment[] = [];
  if (registry.has("lane/in-process")) extra.push({ prompt: registry.get("lane/in-process"), dpi: { layer: "core", priority: -100 } });
  const ctx: SessionSpawnContext = {
    role: "worker", parentId: "orch", name: "lifecycle", workerId: "w-life", model: "glm-stub", effort: null,
    permissionMode: "acceptEdits", cwd: "/repo", worktreeDir: null, branch: null, repoRoot: null, isAttached: false,
    hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
  };
  return assembleSystemPrompt({ registry, prompts }, ctx, extra).text;
}

const tagOf = (e: AgentEvent): string =>
  e.type === "turn" ? `turn:${e.phase}`
    : e.type === "session" ? `session:${e.phase}`
      : e.type === "message" ? `msg:${e.blocks[0].type}`
        : e.type;

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const t of haystack) if (i < needle.length && t === needle[i]) i++;
  return i === needle.length;
}

function tmp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "eos-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── 1. Canonical lifecycle: real model + real system prompt + real built-in ─────

describe("api-lane full lifecycle (real localhost-stub model)", () => {
  it("drives the canonical event sequence and a real built-in tool round-trip", async (t) => {
    const cwd = tmp(t);
    // Turn 1: stream text + a real Write tool call; Turn 2 (after the tool result
    // returns): stream the final text and end.
    const stub = await startStub((body) => {
      const sawToolResult = body.messages.some((m) => m.role === "tool");
      if (!sawToolResult) {
        return [
          textDelta("Creating "), textDelta("the file."),
          toolCallChunk("call_write", "Write", { file_path: "out.txt", content: "hello world" }),
          finish("tool_calls"), usage(42, 8),
        ];
      }
      return [textDelta("Done."), finish("stop"), usage(55, 3)];
    });
    t.after(() => stub.close());

    const system = realSystemPrompt();
    assert.ok(system.length > 0 && /send_message_to_parent/.test(system), "a real worker system prompt was assembled");

    const env: InProcessEnv = {
      model: createOpenAIModelClient({ apiKey: "", model: "glm-stub", baseUrl: stub.url, system, tools: toolSpecs, capabilities: CAPS }),
      tools: new Map<string, RuntimeTool>([
        [writeTool.name, bindBuiltinTool(writeTool, { cwd })],
        [readTool.name, bindBuiltinTool(readTool, { cwd })],
      ]),
      gate: allowGate,
    };
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("openai", () => env);
    const spec: AgentLaunchSpec = { workerId: "w-life", cwd, model: "glm-stub", prompt: "Create out.txt containing hello world", persistent: false, parentId: "orch", isOrchestrator: false };
    const session = await be.start(spec, { onEvent: (e) => events.push(e) });
    await be.whenSettled("w-life");

    // G1 wire evidence over a real socket: keyless (apiKey:"") → NO Authorization
    // header, composed path is exactly <origin>/v1/chat/completions, and the real
    // assembled system prompt was delivered as the leading system message.
    assert.equal(stub.requests[0].url, "/v1/chat/completions", "composed URL is <origin>/v1/chat/completions");
    assert.equal(stub.requests[0].auth, undefined, "keyless localhost sends no Authorization header");
    assert.equal(stub.requests[0].body.messages[0].role, "system");
    assert.equal(stub.requests[0].body.messages[0].content, system, "the real system prompt was delivered over the wire");

    // The real built-in actually wrote to disk through the loop (not a stub tool).
    assert.ok(existsSync(join(cwd, "out.txt")), "the real Write built-in created the file");
    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "hello world");

    // Canonical sequence: session started → turn → delta → message → usage → context
    // → (tool_call → tool_result) → turn ended. Assert as an ordered subsequence so
    // the exact number of streamed deltas doesn't make the test brittle.
    const tags = events.map(tagOf);
    assert.equal(tags[0], "session:started");
    assert.equal(tags[tags.length - 1], "turn:ended");
    assert.ok(tags.includes("delta"), "live deltas were emitted (streaming path)");
    assert.ok(
      isSubsequence(
        ["session:started", "turn:started", "delta", "msg:text", "usage", "context", "msg:tool_call", "msg:tool_result", "turn:ended"],
        tags,
      ),
      `canonical sequence not found in: ${tags.join(" ")}`,
    );
    assert.ok(session.isAlive());
  });

  // ─── 2. Durability persist → restart → resume, over the real HTTP client ───────

  it("persists a turn and rehydrates the conversation on resume (real client + JSONL store)", async (t) => {
    const dir = tmp(t);
    const store = new JsonlConversationStore(join(dir, "conversations"));
    const ids = randomIdGenerator;

    // Daemon run 1: spawn + one turn → the user task is persisted under the session id.
    const stub1 = await startStub(() => [textDelta("ack"), finish("stop"), usage(5, 1)]);
    t.after(() => stub1.close());
    const env1: InProcessEnv = { model: createOpenAIModelClient({ apiKey: "", model: "glm-stub", baseUrl: stub1.url, capabilities: CAPS }), tools: new Map(), gate: allowGate };
    const events: AgentEvent[] = [];
    const be1 = createInProcessBackend("openai", () => env1, { store, ids });
    await be1.start({ workerId: "w-dur", cwd: dir, model: "glm-stub", prompt: "first task", persistent: true, parentId: null, isOrchestrator: false }, { onEvent: (e) => events.push(e) });
    await be1.whenSettled("w-dur");

    const ready = events.find((e): e is Extract<AgentEvent, { type: "session"; phase: "ready" }> => e.type === "session" && e.phase === "ready");
    assert.ok(ready?.sessionId, "start emitted session ready + a durable sessionId");
    const persisted = store.load(ready!.sessionId);
    assert.ok(persisted && persisted.some((m) => m.role === "user" && m.content === "first task"), "the conversation was persisted");

    // Daemon run 2: a FRESH backend (empty live registry) resumes via start({resume}) —
    // NOT attach — so the store rehydrates the prior history before the next turn.
    const stub2 = await startStub(() => [textDelta("resumed"), finish("stop"), usage(6, 1)]);
    t.after(() => stub2.close());
    const env2: InProcessEnv = { model: createOpenAIModelClient({ apiKey: "", model: "glm-stub", baseUrl: stub2.url, capabilities: CAPS }), tools: new Map(), gate: allowGate };
    const be2 = createInProcessBackend("openai", () => env2, { store, ids });
    const session2 = await be2.start({ workerId: "w-dur", cwd: dir, model: "glm-stub", prompt: "", persistent: true, parentId: null, isOrchestrator: false, backendOptions: { resume: ready!.sessionId } }, {});
    await be2.whenSettled("w-dur");
    await session2.sendMessage("second task");
    await be2.whenSettled("w-dur");

    // The model on run 2 sees the rehydrated "first task" followed by the new turn —
    // the conversation survived the simulated restart end-to-end over the wire.
    const userContents = stub2.requests[0].body.messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(userContents.includes("first task"), "rehydrated history reached the model after resume");
    assert.ok(userContents.includes("second task"), "the new turn was appended to the rehydrated history");
  });

  // ─── 3. Context compaction near the window, inside the real loop ───────────────

  it("compacts oldest tool-turns near the context window so the turn continues (no 400)", async (t) => {
    const dir = tmp(t);
    const store = new JsonlConversationStore(join(dir, "conversations"));

    // Pre-seed a large prior conversation (40 matched tool-turns) that overflows a
    // small 2k window, then resume into it.
    const big: ModelMessage[] = [{ role: "user", content: "original task" }];
    for (let i = 0; i < 40; i++) {
      big.push({ role: "assistant", content: [{ callId: `c${i}`, name: "Read", input: { file_path: `f${i}.txt` } }] });
      big.push({ role: "tool", content: { callId: `c${i}`, result: "X".repeat(200), isError: false } });
    }
    store.save("w-comp", "s-big", big);

    const stub = await startStub(() => [textDelta("ok"), finish("stop"), usage(10, 1)]);
    t.after(() => stub.close());
    const smallWindow: ProviderCapabilities = { ...CAPS, contextWindow: 2000 };
    const env: InProcessEnv = {
      model: createOpenAIModelClient({ apiKey: "", model: "glm-stub", baseUrl: stub.url, capabilities: smallWindow }),
      tools: new Map<string, RuntimeTool>([[readTool.name, bindBuiltinTool(readTool, { cwd: dir })]]),
      gate: allowGate,
      capabilities: smallWindow,
      compactor: new DropOldestContextCompactor(),
    };
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("openai", () => env, { store, ids: randomIdGenerator });
    const session = await be.start({ workerId: "w-comp", cwd: dir, model: "glm-stub", prompt: "", persistent: true, parentId: null, isOrchestrator: false, backendOptions: { resume: "s-big" } }, { onEvent: (e) => events.push(e) });
    await be.whenSettled("w-comp");
    await session.sendMessage("continue");
    await be.whenSettled("w-comp");

    const sent = stub.requests[0].body.messages;
    // The compactor ran INSIDE the loop before the model call: the request carries far
    // fewer messages than the 82 (seeded + new) it would otherwise, includes the
    // retained truncation marker, and the turn completed without a window error.
    assert.ok(sent.length < big.length + 1, `compacted: ${sent.length} < ${big.length + 1} messages`);
    assert.match(JSON.stringify(sent), /truncated to fit/, "the retained compaction marker is present");
    assert.ok(!events.some((e) => e.type === "turn" && e.phase === "error" && e.reason === "context_window_exceeded"), "no context_window_exceeded error");
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"), "the turn continued to completion");
  });
});
