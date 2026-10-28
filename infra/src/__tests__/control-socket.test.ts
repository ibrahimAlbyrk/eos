import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlSocketPath } from "../platform/control-socket.ts";

describe("controlSocketPath", () => {
  it("is daemon.sock in the Eos home", () => {
    assert.equal(controlSocketPath("/Users/me/.eos", "socket"), "/Users/me/.eos/daemon.sock");
  });

  it("is one named pipe per Eos home on Windows, whatever the home's letter case", () => {
    const pipe = controlSocketPath("C:\\Users\\me\\.eos", "pipe");
    assert.match(pipe, /^\\\\\.\\pipe\\eos-[0-9a-f]{16}$/);
    assert.equal(controlSocketPath("c:\\users\\ME\\.eos", "pipe"), pipe);
    assert.notEqual(controlSocketPath("C:\\Users\\other\\.eos", "pipe"), pipe);
  });
});
