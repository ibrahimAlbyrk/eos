import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTerminalResponder } from "../terminal-responder.ts";

describe("terminalResponder", () => {
  it("answers the capability/status queries it recognizes", () => {
    const cases: Array<[string, string]> = [
      ["\x1b[c", "\x1b[?1;2c"],        // DA1
      ["\x1b[0c", "\x1b[?1;2c"],       // DA1 with explicit 0
      ["\x1b[>0c", "\x1b[>1;95;0c"],   // DA2
      ["\x1b[>0q", "\x1bP>|eos-pty\x1b\\"], // XTVERSION
      ["\x1b[?u", "\x1b[?0u"],         // kitty keyboard query
      ["\x1b[5n", "\x1b[0n"],          // DSR status
    ];
    for (const [query, reply] of cases) {
      assert.deepEqual(createTerminalResponder().feed(query), [reply], `query ${JSON.stringify(query)}`);
    }
  });

  it("ignores set/push sequences and plain output (no spurious replies)", () => {
    const r = createTerminalResponder();
    // bracketed-paste enable (the readiness marker), kitty push/set, modifyOtherKeys,
    // cursor show/hide, SGR, and text — none are queries.
    const noise = "\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[?25l hello world\n";
    assert.deepEqual(r.feed(noise), []);
  });

  it("does not answer a cursor-position report request (CSI 6 n) by design", () => {
    assert.deepEqual(createTerminalResponder().feed("\x1b[6n"), []);
  });

  it("replies to exactly the queries in a real boot burst, in order", () => {
    const boot =
      "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h" +
      "\x1b[<u\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[c";
    assert.deepEqual(createTerminalResponder().feed(boot), ["\x1bP>|eos-pty\x1b\\", "\x1b[?1;2c"]);
  });

  it("matches a query split across chunk boundaries exactly once", () => {
    const r = createTerminalResponder();
    assert.deepEqual(r.feed("text\x1b["), []); // partial DA1 held in tail
    assert.deepEqual(r.feed("c more"), ["\x1b[?1;2c"]);
    assert.deepEqual(r.feed("no query here"), []); // no re-match of the consumed query
  });
});
