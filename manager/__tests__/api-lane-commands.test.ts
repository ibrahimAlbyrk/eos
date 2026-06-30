// M6 — prompt-template slash-commands on the in-process lane (§5c). Two faces:
//   1. createCommandTemplateExpander — discovery (project .claude/commands, the
//      `:`→`/` path convention) + the full expansion ($ARGUMENTS/$1, @file, !`cmd`,
//      frontmatter stripped). A non-command / unknown command returns null.
//   2. DispatchMessage gating on capabilities.expandsSlashTemplates — the in-process
//      lane (false) expands and dispatches the expanded text; the claude lanes (true)
//      never expand (no double-expansion). Branch on the capability, never on kind.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCommandTemplateExpander } from "../backends/command-expander.ts";
import { createNodeToolFileSystem } from "../../infra/src/tools/NodeToolFileSystem.ts";
import type { ProcessRunner } from "../../core/src/ports/ProcessRunner.ts";

import { dispatchMessage, type DispatchMessageDeps } from "../../core/src/use-cases/DispatchMessage.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { AgentBackend, AgentSession, AgentCapabilities } from "../../core/src/ports/AgentBackend.ts";
import { fakeQueue } from "../../core/src/__tests__/helpers/fakeMessageQueue.ts";

// ─── 1. The expander: discovery + expansion ─────────────────────────────────────

const fakeProc = (out: Record<string, string> = {}): ProcessRunner => ({
  async run(cmd) { return { stdout: out[cmd] ?? `out(${cmd})`, stderr: "", exitCode: 0, timedOut: false }; },
  startBackground() { return "bg"; },
  readBackground() { return null; },
  killBackground() { return false; },
});

let root: string;
let cwd: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "eos-commands-"));
  cwd = join(root, "project");
  const cmdDir = join(cwd, ".claude", "commands");
  mkdirSync(join(cmdDir, "group"), { recursive: true });
  writeFileSync(join(cmdDir, "deploy.md"), [
    "---",
    "description: Deploy to an environment",
    "argument-hint: <env>",
    "---",
    "Deploy to $1 (full args: $ARGUMENTS).",
    "Status: !`git status`.",
    "Notes: @notes.txt",
  ].join("\n"));
  writeFileSync(join(cmdDir, "group", "sub.md"), "Nested command for $1.");
  writeFileSync(join(cwd, "notes.txt"), "remember to tag the release\n");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("createCommandTemplateExpander — discovery + expansion", () => {
  it("discovers a project command, strips frontmatter, and expands all forms", async () => {
    const expand = createCommandTemplateExpander({ fs: createNodeToolFileSystem(), proc: fakeProc({ "git status": "clean" }) });
    const out = await expand("/deploy staging now", cwd);
    assert.ok(out !== null);
    // frontmatter is gone; $1 + $ARGUMENTS + !`cmd` + @file all resolved.
    assert.ok(!out!.includes("argument-hint"), "frontmatter stripped");
    assert.match(out!, /Deploy to staging \(full args: staging now\)\./);
    assert.match(out!, /Status: clean\./);
    assert.match(out!, /Notes: remember to tag the release/);
  });

  it("resolves the `:`→`/` nested path convention (/group:sub → group/sub.md)", async () => {
    const expand = createCommandTemplateExpander({ fs: createNodeToolFileSystem(), proc: fakeProc() });
    assert.equal(await expand("/group:sub alpha", cwd), "Nested command for alpha.");
  });

  it("returns null for plain text and for an unknown command (no interception)", async () => {
    const expand = createCommandTemplateExpander({ fs: createNodeToolFileSystem(), proc: fakeProc() });
    assert.equal(await expand("just a message", cwd), null);
    assert.equal(await expand("/no-such-command x", cwd), null);
  });
});

// ─── 2. DispatchMessage gating on expandsSlashTemplates ─────────────────────────

function fakeBackend(kind: string, caps: AgentCapabilities, sends: string[]): AgentBackend {
  const session = {
    workerId: "w1",
    handle: { kind: "inproc", ref: "w1" },
    capabilities: caps,
    async sendMessage(text: string) { sends.push(text); return { ok: true, status: 200, body: { ok: true } }; },
  } as unknown as AgentSession;
  const descriptor = { processModel: "in-process", capabilities: caps } as unknown as AgentBackend["descriptor"];
  return { kind, descriptor, start: async () => session, attach: () => session };
}

function gatingDeps(kind: string, caps: AgentCapabilities, sends: string[], expandCalls: Array<{ text: string; cwd: string | null }>): DispatchMessageDeps {
  const backend = fakeBackend(kind, caps, sends);
  const row = { id: "w1", state: "IDLE", port: 7501, pid: 42, backend_kind: kind, is_orchestrator: 0, cwd: "/repo", worktree_dir: null } as unknown as WorkerRow;
  return {
    workers: { findById: () => row, updateState: () => {}, setTurnStartedAt: () => {} },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    clock: { now: () => 1234 },
    queue: fakeQueue().repo,
    client: { sendMessage: async () => ({ ok: true, status: 200, body: { ok: true } }) },
    backends: { has: (k: string) => k === kind, get: () => backend },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
    expandTemplate: async (text, c) => { expandCalls.push({ text, cwd: c }); return text.startsWith("/expandme") ? `EXPANDED(${text})` : null; },
  } as unknown as DispatchMessageDeps;
}

const inProcessCaps = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false } as AgentCapabilities;
const claudeCaps = { ...inProcessCaps, reportsMessageEvents: true, expandsSlashTemplates: true } as AgentCapabilities;

describe("DispatchMessage — expandsSlashTemplates gating", () => {
  it("in-process lane (expandsSlashTemplates falsy): expands the template, dispatches the expanded text", async () => {
    const sends: string[] = [];
    const calls: Array<{ text: string; cwd: string | null }> = [];
    await dispatchMessage(gatingDeps("anthropic-api", inProcessCaps, sends, calls), { workerId: "w1", text: "/expandme go" });
    assert.deepEqual(calls, [{ text: "/expandme go", cwd: "/repo" }], "expander invoked with worker cwd");
    assert.deepEqual(sends, ["EXPANDED(/expandme go)"], "the EXPANDED text reaches the model");
  });

  it("in-process lane: a non-template message dispatches verbatim (expander returns null)", async () => {
    const sends: string[] = [];
    const calls: Array<{ text: string; cwd: string | null }> = [];
    await dispatchMessage(gatingDeps("anthropic-api", inProcessCaps, sends, calls), { workerId: "w1", text: "hello there" });
    assert.equal(calls.length, 1, "expander consulted");
    assert.deepEqual(sends, ["hello there"], "raw text dispatched when not a template");
  });

  it("claude lane (expandsSlashTemplates true): NEVER expands — the binary self-expands", async () => {
    const sends: string[] = [];
    const calls: Array<{ text: string; cwd: string | null }> = [];
    await dispatchMessage(gatingDeps("claude-cli", claudeCaps, sends, calls), { workerId: "w1", text: "/expandme go" });
    assert.equal(calls.length, 0, "expander NOT consulted (no double-expansion)");
    assert.deepEqual(sends, ["/expandme go"], "the raw /command reaches the binary");
  });
});
