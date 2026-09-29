import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startKeepAwake, caffeinateArgs } from "../keepAwake.ts";

function fakeSpawn() {
  const calls: { cmd: string; args: string[] }[] = [];
  let killed = 0;
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return Object.assign(new EventEmitter(), { pid: 4242, unref() {}, kill() { killed++; return true; } });
  }) as never;
  return { spawnFn, calls, killed: () => killed };
}

describe("startKeepAwake", () => {
  it("holds an AC-only system-sleep assertion tied to the daemon pid", () => {
    assert.deepEqual(caffeinateArgs(123), ["-s", "-w", "123"]);
  });

  it("spawns caffeinate on macOS and kills it on release", () => {
    const f = fakeSpawn();
    const release = startKeepAwake({ pid: 99, platform: "darwin", spawnFn: f.spawnFn });
    assert.deepEqual(f.calls, [{ cmd: "/usr/bin/caffeinate", args: ["-s", "-w", "99"] }]);
    release();
    assert.equal(f.killed(), 1);
  });

  it("is a no-op off macOS", () => {
    const f = fakeSpawn();
    startKeepAwake({ platform: "linux", spawnFn: f.spawnFn })();
    assert.equal(f.calls.length, 0);
  });
});
