import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createClaudeCliBackend } from "../../backends/ClaudeCliBackend.ts";
import type { SpawnWorkerSpec } from "../../../core/src/use-cases/SpawnWorker.ts";

// The cutover's single chokepoint: every claude-cli spawn assembles its system
// prompt here and threads the resulting path into buildArgs. Locks that wiring.
describe("ClaudeCliBackend — DPI assembly chokepoint", () => {
  function fakeDeps(overrides: Partial<Parameters<typeof createClaudeCliBackend>[0]>) {
    let argsSpec: SpawnWorkerSpec | null = null;
    const base = {
      supervisor: { spawn: () => ({ pid: 42 }), has: () => true, escalateKill: () => {} } as never,
      ports: { allocate: async () => 7777, release: () => {} } as never,
      client: {} as never,
      buildArgs: ({ spec }: { spec: SpawnWorkerSpec }) => {
        argsSpec = spec;
        return [];
      },
      buildEnv: () => ({}),
      logFileFor: () => "/tmp/x.log",
    };
    return { deps: { ...base, ...overrides }, getArgsSpec: () => argsSpec };
  }

  it("assembles the prompt and threads the path into buildArgs", async () => {
    let calledWith: { spec: SpawnWorkerSpec; id: string } | null = null;
    const { deps, getArgsSpec } = fakeDeps({
      assembleSystemPromptFile: (spec, id) => {
        calledWith = { spec, id };
        return "/eos/system-prompt-w1.md";
      },
    });
    const backend = createClaudeCliBackend(deps);

    await backend.start({
      workerId: "w1",
      cwd: "/repo",
      model: "opus",
      prompt: "",
      persistent: false,
      parentId: "o",
      isOrchestrator: false,
      backendOptions: { spec: { role: "worker", parentId: "o" } as SpawnWorkerSpec },
    });

    assert.equal(calledWith?.id, "w1");
    assert.equal(calledWith?.spec.role, "worker");
    assert.equal(getArgsSpec()?.systemPromptFile, "/eos/system-prompt-w1.md");
  });

  it("falls back to the spec's systemPromptFile when no assembler is injected", async () => {
    const { deps, getArgsSpec } = fakeDeps({});
    const backend = createClaudeCliBackend(deps);

    await backend.start({
      workerId: "w2",
      cwd: "/r",
      model: "opus",
      prompt: "",
      persistent: false,
      parentId: null,
      isOrchestrator: false,
      backendOptions: { spec: { systemPromptFile: "/legacy.md" } as SpawnWorkerSpec },
    });

    assert.equal(getArgsSpec()?.systemPromptFile, "/legacy.md");
  });
});

// Runtime model switch is the /model slash command (+ /effort) delivered over the
// worker client — the mechanism moved out of SetWorkerModel into this adapter so
// the use-case stays backend-agnostic.
describe("ClaudeCliBackend — runtime model switch", () => {
  it("setModel sends /model (and /effort) over the worker client", async () => {
    const sent: string[] = [];
    const backend = createClaudeCliBackend({
      supervisor: { spawn: () => ({ pid: 42 }), has: () => true, escalateKill: () => {} } as never,
      ports: { allocate: async () => 7777, release: () => {} } as never,
      client: { sendMessage: async (_port: number, text: string) => { sent.push(text); return { ok: true, status: 200, body: {} }; } } as never,
      buildArgs: () => [],
      buildEnv: () => ({}),
      logFileFor: () => "/tmp/x.log",
    });
    const session = backend.attach("w1", { kind: "http", port: 7777, pid: 42 });
    assert.equal(session.capabilities.runtimeModelSwitch, true);
    assert.deepEqual(await session.setModel("opus", "high"), { ok: true });
    assert.deepEqual(sent, ["/model opus", "/effort high"]);
  });

  it("setModel omits /effort when no effort is given", async () => {
    const sent: string[] = [];
    const backend = createClaudeCliBackend({
      supervisor: { spawn: () => ({ pid: 42 }), has: () => true, escalateKill: () => {} } as never,
      ports: { allocate: async () => 7777, release: () => {} } as never,
      client: { sendMessage: async (_port: number, text: string) => { sent.push(text); return { ok: true, status: 200, body: {} }; } } as never,
      buildArgs: () => [],
      buildEnv: () => ({}),
      logFileFor: () => "/tmp/x.log",
    });
    const session = backend.attach("w1", { kind: "http", port: 7777, pid: 42 });
    assert.deepEqual(await session.setModel("sonnet"), { ok: true });
    assert.deepEqual(sent, ["/model sonnet"]);
  });
});
