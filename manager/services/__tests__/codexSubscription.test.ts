import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createCodexSubscription, startCodexSignIn, type CodexSubscriptionDeps } from "../accounts/codexSubscription.ts";
import { fakeAppServer } from "../../backends/codex/__tests__/fakeAppServer.ts";

const URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=x&state=y";

function fakeCli() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    killed: false,
    kill() { this.killed = true; return true; },
  });
  const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
  return {
    child,
    spawned,
    spawnFn: (cmd: string, args: string[], o: { env: Record<string, string | undefined> }) => {
      spawned.push({ cmd, args, env: o.env });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    exit(code: number) { child.exitCode = code; child.emit("exit", code); },
  };
}

function setup(over: Partial<CodexSubscriptionDeps> = {}) {
  const cli = fakeCli();
  const server = fakeAppServer({});
  const deps: CodexSubscriptionDeps = {
    binary: "/bin/codex",
    env: () => ({ CODEX_HOME: "/eos/accounts/codex" }),
    open: async () => server,
    spawnFn: cli.spawnFn,
    ...over,
  };
  return { cli, server, deps };
}

describe("Sign in with ChatGPT (Codex)", () => {
  it("runs `codex login` with the Eos env, reports the URL once, and succeeds on exit 0", async () => {
    const t = setup();
    const urls: string[] = [];
    const flow = startCodexSignIn(t.deps, { onUrl: (u) => urls.push(u) });
    assert.deepEqual(t.cli.spawned, [{ cmd: "/bin/codex", args: ["login"], env: { CODEX_HOME: "/eos/accounts/codex" } }]);
    t.cli.child.stdout.write("Starting local login server on http://localhost:1455.\n");
    t.cli.child.stdout.write(`${URL}\n\n`);
    t.cli.child.stderr.write(`${URL}\n`);
    t.cli.child.stdout.write("Successfully logged in\n");
    await new Promise((r) => setImmediate(r));
    t.cli.exit(0);
    assert.equal(await flow.result, "");
    assert.deepEqual(urls, [URL]);
  });

  it("fails with the CLI's last line when it exits non-zero", async () => {
    const t = setup();
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    t.cli.child.stderr.write("Error logging in: access denied\n");
    await new Promise((r) => setImmediate(r));
    t.cli.exit(1);
    await assert.rejects(flow.result, /Sign-in ended: Error logging in: access denied/);
  });

  it("cancel kills the CLI (and its callback server)", async () => {
    const t = setup();
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    flow.cancel();
    await assert.rejects(flow.result, /cancelled/);
    assert.equal(t.cli.child.killed, true);
  });

  it("fails clearly when Codex isn't installed", async () => {
    const t = setup({ binary: null });
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    await assert.rejects(flow.result, /isn't installed/);
    assert.deepEqual(t.cli.spawned, []);
  });

  it("takes no pasted code; signing out logs Codex out", async () => {
    const t = setup();
    const provider = createCodexSubscription(t.deps);
    assert.equal(provider.id, "openai");
    assert.equal(provider.acceptsCode, false);
    await provider.signOut();
    assert.deepEqual(t.server.requests.at(-1), { method: "account/logout", params: {} });
    assert.equal(t.server.closed, true);
  });
});
