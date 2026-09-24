import { test } from "node:test";
import assert from "node:assert/strict";
import { ptyEnv } from "../pty-host.ts";

test("ptyEnv keeps the user env but overrides the terminal identity", () => {
  const env = ptyEnv({ PATH: "/bin", TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" });
  assert.deepEqual(env, { PATH: "/bin", TERM: "xterm-256color", TERM_PROGRAM: "eos", COLORTERM: "truecolor", FORCE_HYPERLINK: "1" });
});
