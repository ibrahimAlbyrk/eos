import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiBackend, type GeminiBackendDeps } from "../GeminiBackend.ts";
import type { AcpOptions } from "../AcpClient.ts";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import type { AgentLaunchSpec } from "../../../../core/src/ports/AgentBackend.ts";
import { fakeAppServer, type FakeAppServer } from "../../codex/__tests__/fakeAppServer.ts";

const tick = () => new Promise((r) => setImmediate(r));

const MCP = [{ name: "worker", command: "node", args: ["w.ts"], env: [{ name: "EOS_WORKER_ID", value: "w1" }] }];

function setup(over: Partial<GeminiBackendDeps> = {}) {
  const prompts: Array<(r: unknown) => void> = [];
  const server = fakeAppServer({
    "session/new": () => ({ sessionId: "s1", models: { currentModelId: "auto-gemini-2.5", availableModels: [{ modelId: "gemini-2.5-pro" }, { modelId: "auto-gemini-2.5" }] } }),
    "session/load": () => ({}),
    "session/prompt": () => new Promise((r) => prompts.push(r)),
  });
  const opened: AcpOptions[] = [];
  const decisions: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  let allow = true;
  const deps: GeminiBackendDeps = {
    binary: "/bin/gemini",
    policy: { decide: async (i) => { decisions.push({ toolName: i.toolName, input: i.input }); return { behavior: allow ? "allow" : "deny" }; } },
    env: () => ({ PATH: "/bin" }),
    mcpServersFor: () => MCP,
    eosMcpServers: ["orchestrator", "worker"],
    policyFile: join(mkdtempSync(join(tmpdir(), "eos-gemini-policy-")), "policy.toml"),
    assembleInstructions: () => "EOS PROTOCOL",
    open: async (opts) => { opened.push(opts); return server; },
    ...over,
  };
  const events: AgentEvent[] = [];
  const exits: number[] = [];
  const backend = createGeminiBackend(deps);
  const spec = (s: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec => ({
    workerId: "w1", cwd: "/repo", model: "gemini-2.5-pro", prompt: "", persistent: true, parentId: "p1", isOrchestrator: false, ...s,
  } as AgentLaunchSpec);
  const start = (s: Partial<AgentLaunchSpec> = {}) =>
    backend.start(spec(s), { onEvent: (e) => events.push(e), onExit: (c) => exits.push(c) });
  const endPrompt = (stopReason = "end_turn") => prompts.shift()?.({ stopReason });
  return { server, backend, deps, opened, events, exits, decisions, start, endPrompt, setAllow: (v: boolean) => { allow = v; } };
}

const sent = (server: FakeAppServer, method: string) => server.requests.filter((r) => r.method === method);
const promptText = (server: FakeAppServer, i: number) =>
  (sent(server, "session/prompt")[i].params.prompt as Array<{ text: string }>).map((p) => p.text);

describe("GeminiBackend", () => {
  it("describes a subscription lane with its own session store", () => {
    const { backend } = setup();
    assert.equal(backend.descriptor.kind, "gemini-cli");
    assert.equal(backend.descriptor.billing, "subscription");
    assert.equal(backend.descriptor.sessionStore, "gemini-session");
    assert.equal(backend.descriptor.enabled, true);
    assert.equal(setup({ binary: null }).backend.descriptor.enabled, false);
  });

  it("starts a gated session with Eos's MCP servers pre-approved, then reports its id", async () => {
    const t = setup();
    await t.start();
    assert.deepEqual(t.opened[0].args, ["--approval-mode", "default", "--policy", t.deps.policyFile]);
    assert.equal(t.opened[0].cwd, "/repo");
    assert.match(readFileSync(t.deps.policyFile, "utf8"), /mcpName = "orchestrator"\ndecision = "allow"[\s\S]*mcpName = "worker"/);
    assert.deepEqual(sent(t.server, "session/new")[0].params, { cwd: "/repo", mcpServers: MCP });
    assert.deepEqual(sent(t.server, "session/set_model")[0].params, { sessionId: "s1", modelId: "gemini-2.5-pro" });
    assert.deepEqual(t.events, [{ type: "session", phase: "started" }, { type: "session", phase: "ready", sessionId: "s1" }]);
  });

  it("keeps Gemini's default model for a model that isn't Gemini's", async () => {
    const t = setup();
    await t.start({ model: "opus" });
    assert.equal(sent(t.server, "session/set_model").length, 0);
  });

  it("resumes a saved chat, and starts fresh when that fails", async () => {
    const t = setup();
    await t.start({ backendOptions: { resume: "s-old" } } as Partial<AgentLaunchSpec>);
    assert.deepEqual(sent(t.server, "session/load")[0].params, { sessionId: "s-old", cwd: "/repo", mcpServers: MCP });
    assert.equal(sent(t.server, "session/new").length, 0);

    const u = setup();
    u.server.handlers["session/load"] = () => { throw new Error("session not found"); };
    await u.start({ backendOptions: { resume: "gone" } } as Partial<AgentLaunchSpec>);
    assert.equal(sent(u.server, "session/new").length, 1);
  });

  it("Eos's instructions ride a fresh session's first prompt only", async () => {
    const t = setup();
    const s = await t.start({ prompt: "hello" });
    assert.deepEqual(promptText(t.server, 0), ["<eos-instructions>\nEOS PROTOCOL\n</eos-instructions>", "hello"]);
    t.endPrompt();
    await tick();
    await s.sendMessage("again");
    assert.deepEqual(promptText(t.server, 1), ["again"]);

    const resumed = setup();
    const r = await resumed.start({ backendOptions: { resume: "s-old" } } as Partial<AgentLaunchSpec>);
    await r.sendMessage("continue");
    assert.deepEqual(promptText(resumed.server, 0), ["continue"]);
  });

  it("a message sent mid-turn waits for the turn to end, then starts the next one", async () => {
    const t = setup();
    const s = await t.start({ prompt: "first" });
    await s.sendMessage("second");
    await s.sendMessage("third");
    assert.equal(sent(t.server, "session/prompt").length, 1);
    t.endPrompt();
    await tick();
    assert.deepEqual(promptText(t.server, 1), ["second\n\nthird"]);
    assert.deepEqual(t.events.filter((e) => e.type === "turn").map((e) => (e as { phase: string }).phase), ["started", "ended", "started"]);
  });

  it("asks the Eos gateway about each command and edit — one-off answers only", async () => {
    const t = setup();
    await t.start({ prompt: "go" });
    const ask = (toolCall: Record<string, unknown>) => t.server.serverRequest("session/request_permission", {
      sessionId: "s1",
      toolCall,
      options: [
        { optionId: "proceed_always", name: "Always Allow", kind: "allow_always" },
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ],
    });

    const bash = { toolCallId: "run_shell_command-1", kind: "execute", title: "npm test [in .]" };
    assert.deepEqual(await ask(bash), { outcome: { outcome: "selected", optionId: "proceed_once" } });
    assert.deepEqual(t.decisions.at(-1), { toolName: "Bash", input: { command: "npm test" } });
    assert.ok(t.events.some((e) => e.type === "message" && JSON.stringify(e).includes(`"name":"Bash"`)));

    t.setAllow(false);
    const edit = { toolCallId: "replace-2", kind: "edit", title: "a.ts", content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }] };
    assert.deepEqual(await ask(edit), { outcome: { outcome: "selected", optionId: "cancel" } });
    assert.deepEqual(t.decisions.at(-1), { toolName: "Edit", input: { file_path: "/repo/a.ts" } });
    assert.ok(t.events.some((e) => e.type === "message" && JSON.stringify(e).includes("Declined")));

    // Gemini's own question tool has no Eos surface — declined without asking.
    const before = t.decisions.length;
    assert.deepEqual(await ask({ toolCallId: "ask_user-3", kind: "other", title: "Which one?" }), { outcome: { outcome: "selected", optionId: "cancel" } });
    assert.equal(t.decisions.length, before);
  });

  it("session output only counts while a prompt runs — a resumed chat's replay is ignored", async () => {
    const t = setup();
    await t.start();
    const update = { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } };
    t.server.emit("session/update", update);
    assert.equal(t.events.some((e) => e.type === "delta"), false);
  });

  it("interrupt cancels the running prompt; a cancelled prompt ends as aborted", async () => {
    const t = setup();
    const s = await t.start({ prompt: "go" });
    await s.interrupt();
    assert.deepEqual(t.server.notifications.at(-1), { method: "session/cancel", params: { sessionId: "s1" } });
    t.endPrompt("cancelled");
    await tick();
    assert.deepEqual(t.events.at(-1), { type: "turn", phase: "aborted", reason: "interrupted" });
  });

  it("/clear starts a fresh session on the same process, instructions again", async () => {
    const t = setup();
    const s = await t.start();
    t.server.handlers["session/new"] = () => ({ sessionId: "s2" });
    assert.deepEqual(await s.clearContext?.(), { ok: true });
    await s.sendMessage("fresh");
    assert.equal(sent(t.server, "session/prompt")[0].params.sessionId, "s2");
    assert.equal(promptText(t.server, 0).length, 2);
  });

  it("a crash reports the exit, then the session end", async () => {
    const t = setup();
    await t.start();
    t.server.crash(1);
    assert.deepEqual(t.exits, [1]);
    assert.deepEqual(t.events.at(-1), { type: "session", phase: "ended", outcome: "crashed" });
  });

  it("lists the account's models, current first", async () => {
    const t = setup();
    assert.deepEqual(await t.backend.listModels(), ["auto-gemini-2.5", "gemini-2.5-pro"]);
    assert.equal(t.server.closed, true);
  });
});
