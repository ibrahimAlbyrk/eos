import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClaudeSubscription, loginFailure, parseLoginUrl, startClaudeLogin } from "../accounts/claudeSubscription.ts";
import type { PtyHost, PtyHostOptions } from "../../../spawner/pty-host.ts";

const URL = "https://claude.ai/oauth/authorize?code=true&client_id=x&state=y";

function fakePty() {
  let onData: (d: string) => void = () => {};
  let onExit: (code: number) => void = () => {};
  const writes: string[] = [];
  let killed = false;
  let opts: PtyHostOptions | null = null;
  const spawnPty = (o: PtyHostOptions): PtyHost => {
    opts = o;
    return {
      onData: (cb) => { onData = cb; },
      onExit: (cb) => { onExit = cb; },
      write: (d) => { writes.push(d); },
      resize() {},
      kill: () => { killed = true; },
      foreground: () => "claude",
    };
  };
  return {
    spawnPty,
    emit: (d: string) => onData(d),
    exit: (code: number) => onExit(code),
    writes,
    get killed() { return killed; },
    get opts() { return opts; },
  };
}

const start = (pty: ReturnType<typeof fakePty>, onUrl: (u: string) => void = () => {}) =>
  startClaudeLogin({ spawnPty: pty.spawnPty, cwd: "/home", env: { PATH: "/bin" } }, { onUrl });

describe("parseLoginUrl", () => {
  it("finds the sign-in URL through ANSI styling", () => {
    const raw = `Opening browser to sign in…\r\n\x1b[1mIf the browser didn't open, visit:\x1b[0m \x1b[36m${URL}\x1b[39m\r\n`;
    assert.equal(parseLoginUrl(raw), URL);
  });
});

describe("loginFailure", () => {
  it("names a missing Claude Code install", () => {
    assert.match(loginFailure("zsh: command not found: claude\r\n", 127), /isn't installed/);
  });

  it("falls back to the last line the CLI printed", () => {
    assert.equal(loginFailure("\x1b[31mLogin failed: denied\x1b[0m\r\n", 1), "Sign-in ended: Login failed: denied");
  });
});

describe("startClaudeLogin", () => {
  it("runs `claude auth login` one-shot in a wide PTY with the given env", () => {
    const pty = fakePty();
    start(pty);
    assert.equal(pty.opts?.command, "claude auth login --claudeai");
    assert.equal(pty.opts?.exitAfterCommand, true);
    assert.ok((pty.opts?.cols ?? 0) >= 500);
    assert.deepEqual(pty.opts?.env, { PATH: "/bin" });
  });

  it("reports the URL once, then succeeds when the CLI exits 0", async () => {
    const pty = fakePty();
    const urls: string[] = [];
    const flow = start(pty, (u) => urls.push(u));
    pty.emit(`${URL}\r\n`);
    pty.emit("Paste code here if prompted > ");
    pty.emit(`${URL}\r\n`);
    pty.emit("Login successful.\r\n");
    pty.exit(0);
    assert.equal(await flow.result, "");
    assert.deepEqual(urls, [URL]);
    assert.equal(pty.killed, true);
  });

  it("types a pasted code, then Enter", async () => {
    const pty = fakePty();
    const flow = start(pty);
    flow.submitCode("  abc#def  ");
    assert.deepEqual(pty.writes, ["abc#def"]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(pty.writes, ["abc#def", "\r"]);
    flow.cancel();
  });

  it("rejects with the CLI's reason when it exits non-zero", async () => {
    const pty = fakePty();
    const flow = start(pty);
    pty.emit("zsh: command not found: claude\r\n");
    pty.exit(127);
    await assert.rejects(flow.result, /isn't installed/);
  });

  it("cancel rejects and kills the PTY", async () => {
    const pty = fakePty();
    const flow = start(pty);
    flow.cancel();
    await assert.rejects(flow.result, /cancelled/);
    assert.equal(pty.killed, true);
  });
});

describe("createClaudeSubscription", () => {
  it("a sign-in retires the legacy token; a sign-out clears the store and the token", () => {
    const calls: string[] = [];
    const sub = createClaudeSubscription({
      spawnPty: fakePty().spawnPty, cwd: "/home", env: {},
      clearLegacyToken: () => calls.push("token"),
      clearLogin: () => calls.push("store"),
    });
    sub.saveCredential("");
    assert.deepEqual(calls, ["token"]);
    sub.signOut();
    assert.deepEqual(calls, ["token", "store", "token"]);
  });
});
