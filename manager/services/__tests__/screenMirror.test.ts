import { describe, it } from "node:test";
import assert from "node:assert/strict";
import xtermHeadless from "@xterm/headless";
import { createScreenMirror } from "../pty/screenMirror.ts";

// Writes a snapshot into a fresh terminal (what a reattaching client does) and
// reads back its screen + modes.
async function replay(snapshot: string, cols: number, rows: number) {
  const term = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => term.write(snapshot, r));
  const buf = term.buffer.active;
  const lines = Array.from({ length: rows }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
  return { lines, buffer: buf.type, mouse: term.modes.mouseTrackingMode };
}

describe("screenMirror", () => {
  it("replays a TUI screen drawn long before the last 256KB of output", async () => {
    const mirror = createScreenMirror(40, 6);
    // Startup: alt screen, SGR mouse, hidden cursor, then the static frame.
    mirror.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?25l");
    mirror.write("\x1b[5;1H╭ prompt ╮\x1b[6;1Hctx 80%");
    // Then only cell diffs — the spinner/counter — far past the old ring cap.
    for (let i = 0; i < 40_000; i++) mirror.write(`\x1b[1;1Hworking ${i % 10}`);
    mirror.write("\x1b[6;5H83");

    const snap = await mirror.snapshot();
    assert.ok(snap.length < 64 * 1024, "a screen, not a byte log");
    assert.ok(snap.includes("\x1b[?1006h") && snap.includes("\x1b[?25l"));
    const screen = await replay(snap, 40, 6);
    assert.equal(screen.buffer, "alternate");
    assert.equal(screen.mouse, "drag");
    assert.equal(screen.lines[0], "working 9");
    assert.equal(screen.lines[4], "╭ prompt ╮");
    assert.equal(screen.lines[5], "ctx 83%");
  });

  it("covers exactly what was written before the call", async () => {
    const mirror = createScreenMirror(20, 3);
    mirror.write("a");
    const snap = mirror.snapshot();
    mirror.write("b");
    assert.equal((await replay(await snap, 20, 3)).lines[0], "a");
  });

  it("forgets tracked modes on a full reset", async () => {
    const mirror = createScreenMirror(20, 3);
    mirror.write("\x1b[?1000;1006h\x1b[?25l\x1bcshell$ ");
    const snap = await mirror.snapshot();
    assert.ok(!snap.includes("\x1b[?1006h") && !snap.includes("\x1b[?25l"));
  });
});
