import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { openAcpAgent } from "../AcpClient.ts";

function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { sent: Array<Record<string, unknown>>; reply(msg: unknown): void };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: () => { child.emit("exit", 143); return true; } });
  child.sent = [];
  stdin.on("data", (d: Buffer) => { for (const line of d.toString().split("\n").filter(Boolean)) child.sent.push(JSON.parse(line)); });
  child.reply = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);
  return { child, stderr };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("AcpClient", () => {
  it("runs `gemini --acp …` and the ACP initialize handshake, offering no fs or terminal", async () => {
    const { child } = fakeChild();
    let argv: string[] = [];
    const opening = openAcpAgent({ binary: "gemini", args: ["--approval-mode", "default"], env: {}, spawnFn: (_cmd, args) => { argv = args; return child; } });
    await tick();
    assert.deepEqual(argv, ["--acp", "--approval-mode", "default"]);
    assert.deepEqual(child.sent[0], {
      id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
    child.reply({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, authMethods: [] } });
    const client = await opening;
    assert.equal(client.isAlive(), true);
  });

  it("a failed start names the CLI's last log line", async () => {
    const { child, stderr } = fakeChild();
    const opening = openAcpAgent({ binary: "gemini", env: {}, spawnFn: () => child });
    stderr.write("Error: Node.js 18 is not supported\n");
    await tick();
    child.emit("exit", 1);
    await assert.rejects(opening, /Gemini didn't start: Gemini CLI exited \(Error: Node.js 18 is not supported\)/);
  });
});
