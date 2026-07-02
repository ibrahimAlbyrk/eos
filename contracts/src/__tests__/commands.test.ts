import { test } from "node:test";
import assert from "node:assert/strict";
import { commandRequest } from "../commands/types.ts";
import {
  spawnWorkerCommand,
  killWorkerCommand,
  archiveWorkerCommand,
  restoreWorkerCommand,
  purgeWorkerCommand,
  commandByName,
  COMMANDS,
} from "../commands/defs.ts";

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

test("commandRequest builds POST + empty body for worker.archive", () => {
  const req = commandRequest(archiveWorkerCommand, { id: "w-1" }, {});
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/workers/w-1/archive");
  assert.deepEqual(req.body, {});
});

test("worker.archive encodes actorId as query and escapes the id", () => {
  const req = commandRequest(archiveWorkerCommand, { id: "w/1", actorId: "o 2" }, {});
  assert.equal(req.path, "/workers/w%2F1/archive?actorId=o%202");
});

test("commandRequest builds POST + empty body for worker.restore", () => {
  const req = commandRequest(restoreWorkerCommand, { id: "w-1" }, {});
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/workers/w-1/restore");
  assert.deepEqual(req.body, {});
});

test("commandRequest builds DELETE + no body for worker.purge", () => {
  const req = commandRequest(purgeWorkerCommand, { id: "w-1" }, {});
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/workers/w-1/purge");
  assert.equal(req.body, undefined);
});

test("worker.purge encodes actorId as query and escapes the id", () => {
  const req = commandRequest(purgeWorkerCommand, { id: "w/1", actorId: "o 2" }, {});
  assert.equal(req.path, "/workers/w%2F1/purge?actorId=o%202");
});

test("worker.kill's pattern cannot shadow the purge path", () => {
  // Both are DELETEs; the first-match router must never hand /workers/x/purge
  // to worker.kill — its [^/]+ id segment cannot cross the slash.
  const kill = killWorkerCommand.pattern as RegExp;
  assert.equal(kill.test("/workers/w-1/purge"), false);
  assert.equal((purgeWorkerCommand.pattern as RegExp).test("/workers/w-1/purge"), true);
});

test("commandByName resolves catalog entries", () => {
  assert.equal(commandByName.get("worker.spawn"), spawnWorkerCommand);
  assert.equal(commandByName.get("worker.kill"), killWorkerCommand);
  assert.equal(commandByName.get("nope"), undefined);
});

test("every catalog command is registered under its own name", () => {
  for (const cmd of COMMANDS) assert.equal(commandByName.get(cmd.name), cmd);
});
