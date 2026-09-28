import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnAppServer, openAppServer } from "../AppServerClient.ts";

function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { sent: Array<Record<string, unknown>>; reply(msg: unknown): void };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: () => { child.emit("exit", 143); return true; } });
  child.sent = [];
  let buf = "";
  stdin.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      child.sent.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.reply = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);
  return child;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("AppServerClient", () => {
  it("frames requests as JSON lines and resolves the matching response", async () => {
    const child = fakeChild();
    const client = spawnAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    const p = client.request("model/list", { limit: 1 });
    await tick();
    assert.deepEqual(child.sent[0], { id: 1, method: "model/list", params: { limit: 1 } });
    child.reply({ id: 1, result: { data: [] } });
    assert.deepEqual(await p, { data: [] });
  });

  it("rejects with the server's error message", async () => {
    const child = fakeChild();
    const client = spawnAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    const p = client.request("turn/interrupt", {});
    await tick();
    child.reply({ id: 1, error: { code: -32600, message: "no active turn" } });
    await assert.rejects(p, /no active turn/);
  });

  it("delivers notifications and answers server requests through the handler", async () => {
    const child = fakeChild();
    const client = spawnAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    const seen: string[] = [];
    client.onNotification((m) => seen.push(m));
    client.onRequest(async (m, p) => ({ decision: m === "item/commandExecution/requestApproval" && p.command === "ls" ? "accept" : "decline" }));
    child.reply({ method: "turn/started", params: { threadId: "t" } });
    child.reply({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    await tick();
    assert.deepEqual(seen, ["turn/started"]);
    assert.deepEqual(child.sent.at(-1), { id: 7, result: { decision: "accept" } });
  });

  it("a handler failure is sent back as a JSON-RPC error", async () => {
    const child = fakeChild();
    const client = spawnAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    client.onRequest(async () => { throw new Error("nope"); });
    child.reply({ id: 3, method: "x/y", params: {} });
    await tick();
    assert.deepEqual(child.sent.at(-1), { id: 3, error: { code: -32603, message: "nope" } });
  });

  it("an exit rejects in-flight requests and reports once", async () => {
    const child = fakeChild();
    const client = spawnAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    const exits: Array<number | null> = [];
    client.onExit((c) => exits.push(c));
    const p = client.request("thread/start", {});
    child.emit("exit", 1);
    child.emit("exit", 1);
    await assert.rejects(p, /exited/);
    assert.deepEqual(exits, [1]);
    assert.equal(client.isAlive(), false);
  });

  it("openAppServer runs the initialize handshake", async () => {
    const child = fakeChild();
    const opening = openAppServer({ binary: "codex", env: {}, spawnFn: () => child });
    await tick();
    assert.equal(child.sent[0].method, "initialize");
    child.reply({ id: 1, result: { codexHome: "/h" } });
    const client = await opening;
    await tick();
    assert.deepEqual(child.sent[1], { method: "initialized" });
    assert.equal(client.isAlive(), true);
  });
});
