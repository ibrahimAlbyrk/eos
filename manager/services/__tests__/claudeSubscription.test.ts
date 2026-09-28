import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSetupTokenOutput, setupTokenFailure, startClaudeSetupToken } from "../accounts/claudeSubscription.ts";
import type { PtyHost, PtyHostOptions } from "../../../spawner/pty-host.ts";

const TOKEN = `sk-ant-oat01-${"a".repeat(90)}`;
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
  startClaudeSetupToken({ spawnPty: pty.spawnPty, cwd: "/home", env: { PATH: "/bin" } }, { onUrl });

describe("parseSetupTokenOutput", () => {
  it("finds the sign-in URL through ANSI styling", () => {
    const raw = `\x1b[1mBrowser didn't open? Use the url below:\x1b[0m\r\n\x1b[36m${URL}\x1b[39m\r\n`;
    assert.equal(parseSetupTokenOutput(raw).url, URL);
  });

  it("takes the token only once something follows it (no truncated token mid-chunk)", () => {
    assert.equal(parseSetupTokenOutput(`Your OAuth token (valid for 1 year):\r\n${TOKEN.slice(0, 60)}`).token, undefined);
    assert.equal(parseSetupTokenOutput(`Your OAuth token (valid for 1 year):\r\n${TOKEN}\r\n`).token, TOKEN);
    assert.equal(parseSetupTokenOutput(`${TOKEN}`, { final: true }).token, TOKEN);
  });
});

describe("setupTokenFailure", () => {
  it("names a missing Claude Code install", () => {
    assert.match(setupTokenFailure("zsh: command not found: claude\r\n", 127), /isn't installed/);
  });

  it("falls back to the last line the CLI printed", () => {
    assert.equal(setupTokenFailure("\x1b[31mOAuth error: denied\x1b[0m\r\n", 1), "Sign-in ended: OAuth error: denied");
  });
});

describe("startClaudeSetupToken", () => {
  it("runs `claude setup-token` one-shot in a wide PTY with the given env", () => {
    const pty = fakePty();
    start(pty);
    assert.equal(pty.opts?.command, "claude setup-token");
    assert.equal(pty.opts?.exitAfterCommand, true);
    assert.ok((pty.opts?.cols ?? 0) >= 500);
    assert.deepEqual(pty.opts?.env, { PATH: "/bin" });
  });

  it("reports the URL once, then resolves with the token and kills the PTY", async () => {
    const pty = fakePty();
    const urls: string[] = [];
    const flow = start(pty, (u) => urls.push(u));
    pty.emit(`${URL}\r\n`);
    pty.emit("Paste code here if prompted > ");
    pty.emit(`${URL}\r\n`);
    pty.emit(`\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n`);
    assert.equal(await flow.result, TOKEN);
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

  it("rejects with the CLI's reason when it exits without a token", async () => {
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
