// The xterm side of the screen-mirror comparison.
//
//   snapshot <script.bin> <cols> <rows> [<cols2> <rows2>]   what GET /pty/:id/buffer returns today
//                                                           (resized to the second size after the bytes)
//   state <cols> <rows> < bytes             the terminal a client ends up with after writing those bytes
//
// `snapshot` is manager/services/pty/screenMirror.ts line for line (that file
// resolves @xterm/* from manager/node_modules, which this worktree does not
// install). `state` dumps every line of the active and the normal buffer cell
// by cell, the cursor and the modes — two byte streams are equivalent for a
// client when their states are equal.
import { readFileSync } from "node:fs";

import xtermSerialize from "@xterm/addon-serialize";
import xtermHeadless from "@xterm/headless";

const SCROLLBACK = 1000;

function createScreenMirror(cols: number, rows: number) {
  const term = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new xtermSerialize.SerializeAddon();
  term.loadAddon(serializer);
  let sgrMouse = false;
  let cursorHidden = false;
  const trackModes = (on: boolean) => (params: (number | number[])[]): boolean => {
    if (params.includes(1006)) sgrMouse = on;
    if (params.includes(25)) cursorHidden = !on;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackModes(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackModes(false));
  term.parser.registerEscHandler({ final: "c" }, () => { sgrMouse = false; cursorHidden = false; return false; });
  return {
    write: (data: string | Uint8Array) => term.write(data),
    resize: (c: number, r: number) => new Promise<void>((done) => term.write("", () => { term.resize(c, r); done(); })),
    snapshot: () => new Promise<string>((resolve) => {
      term.write("", () => resolve(serializer.serialize() + (sgrMouse ? "\x1b[?1006h" : "") + (cursorHidden ? "\x1b[?25l" : "")));
    }),
  };
}

type Line = { text: string; wrapped: boolean; cells: string };

function dumpBuffer(buf: any, cols: number): Line[] {
  const lines: Line[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)!;
    const runs: string[] = [];
    let last = "";
    for (let x = 0; x < cols; x++) {
      const c = line.getCell(x)!;
      // A cell that shows nothing — empty or a space, default background, no
      // line through or under it — looks the same whatever else it carries.
      const blank = (c.getChars() === "" || c.getChars() === " ") && c.isBgDefault() && !c.isInverse() && !c.isUnderline() && !c.isStrikethrough() && !c.isOverline();
      const attrs = blank ? "" : [
        c.isFgDefault() ? "d" : `${c.getFgColorMode()}:${c.getFgColor()}`,
        c.isBgDefault() ? "d" : `${c.getBgColorMode()}:${c.getBgColor()}`,
        (c.isBold() ? "b" : "") + (c.isDim() ? "d" : "") + (c.isItalic() ? "i" : "") + (c.isUnderline() ? "u" : "") +
        (c.isInverse() ? "v" : "") + (c.isStrikethrough() ? "s" : "") + (c.isInvisible() ? "h" : "") + (c.isBlink() ? "k" : "") + (c.isOverline() ? "o" : ""),
      ].join("/");
      if (attrs !== last) { runs.push(`${x}=${attrs}`); last = attrs; }
    }
    lines.push({ text: line.translateToString(true), wrapped: line.isWrapped, cells: runs.join(" ") });
  }
  return lines;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "snapshot") {
  const [file, cols, rows, cols2, rows2] = args;
  const mirror = createScreenMirror(Number(cols), Number(rows));
  mirror.write(readFileSync(file));
  if (cols2) await mirror.resize(Number(cols2), Number(rows2));
  process.stdout.write(await mirror.snapshot());
} else if (mode === "state") {
  const [cols, rows] = args.map(Number);
  const term = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  await new Promise<void>((r) => term.write(readFileSync(0), r));
  const core = (term as any)._core;
  const b = term.buffer;
  const state = {
    active: b.active.type,
    cursor: { x: b.active.cursorX, y: b.active.cursorY },
    cursorHidden: core.coreService.isCursorHidden,
    modes: term.modes,
    mouseEncoding: core.coreMouseService.activeEncoding,
    normal: { baseY: b.normal.baseY, lines: dumpBuffer(b.normal, cols) },
    alternate: b.active.type === "alternate" ? dumpBuffer(b.alternate, cols) : null,
  };
  process.stdout.write(JSON.stringify(state, null, 1) + "\n");
} else {
  throw new Error("usage: mirror.ts snapshot <script.bin> <cols> <rows> | state <cols> <rows>");
}
