import { test } from "node:test";
import assert from "node:assert/strict";
import { commandRequest } from "../commands/types.ts";
import { spawnWorkerCommand, killWorkerCommand, commandByName, COMMANDS } from "../commands/defs.ts";

test("commandRequest builds POST + body for worker.spawn", () => {
  const req = commandRequest(spawnWorkerCommand, {}, { prompt: "hi", cwd: "/x" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/workers");
  assert.deepEqual(req.body, { prompt: "hi", cwd: "/x" });
});

test("commandRequest builds DELETE + no body for worker.kill", () => {
  const req = commandRequest(killWorkerCommand, { id: "w-1" }, {});
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/workers/w-1");
  assert.equal(req.body, undefined);
});

test("worker.kill encodes actorId as query and escapes the id", () => {
  const req = commandRequest(killWorkerCommand, { id: "w/1", actorId: "o 2" }, {});
  assert.equal(req.path, "/workers/w%2F1?actorId=o%202");
  assert.equal(req.body, undefined);
});

test("commandByName resolves catalog entries", () => {
  assert.equal(commandByName.get("worker.spawn"), spawnWorkerCommand);
  assert.equal(commandByName.get("worker.kill"), killWorkerCommand);
  assert.equal(commandByName.get("nope"), undefined);
});

test("every catalog command is registered under its own name", () => {
  for (const cmd of COMMANDS) assert.equal(commandByName.get(cmd.name), cmd);
});
