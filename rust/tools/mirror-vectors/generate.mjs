// Writes the screen-mirror vectors: what today's mirror
// (manager/services/pty/screenMirror.ts — xterm headless + its serialize addon)
// answers for GET /pty/:id/buffer after a terminal session. The Rust mirror
// must give the same text, byte for byte.
//
//   npm ci && node generate.mjs [--fuzz N] [--seed S] [--out FILE]
//
// A vector is a session: a terminal size and steps — bytes written, a resize,
// or a snapshot with the text the mirror returned at that point.
//   scripted   hand-written sequences per feature (colors, cursor moves, the
//              alternate screen, wide characters, scrollback, every attribute)
//   captured   what real programs wrote (captures/*.bin, see capture.py),
//              cut at fixed offsets so a snapshot also lands mid-sequence
//   generated  random walks over everything the terminal understands, from a
//              seeded generator: the same seed gives the same vectors
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import xtermHeadless from "@xterm/headless";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

// Today's mirror itself, with its two imports pointed at this tool's packages
// (the file resolves them from manager/node_modules, which a checkout made for
// the Rust work does not install).
async function loadMirror() {
  const src = readFileSync(join(repo, "manager/services/pty/screenMirror.ts"), "utf8");
  const local = (name) => JSON.stringify(import.meta.resolve(name));
  const patched = src
    .replace('"@xterm/headless"', local("@xterm/headless"))
    .replace('"@xterm/addon-serialize"', local("@xterm/addon-serialize"));
  if (patched === src) throw new Error("screenMirror.ts no longer imports @xterm/* as expected");
  mkdirSync(join(here, ".gen"), { recursive: true });
  const file = join(here, ".gen", "screenMirror.ts");
  writeFileSync(file, patched);
  return (await import(pathToFileURL(file).href)).createScreenMirror;
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const fuzzCount = Number(arg("--fuzz", "300"));
const seed = Number(arg("--seed", "20261111"));
const out = arg("--out", join(here, "..", "..", "crates/eos-pty/tests/fixtures/mirror-vectors.json"));

const ESC = "\x1b";
const CSI = `${ESC}[`;

// ---- scripted sessions -----------------------------------------------------

const scripted = [
  {
    name: "colors",
    steps: [
      `plain ${CSI}1mbold${CSI}22m ${CSI}2mdim${CSI}22m ${CSI}3mitalic${CSI}23m ${CSI}4munder${CSI}24m ${CSI}7minverse${CSI}27m ${CSI}9mstrike${CSI}29m\r\n`,
      [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map((c) => `${CSI}${c}m${c}${CSI}39m `).join("") + "\r\n",
      [40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103].map((c) => `${CSI}${c}m ${c} ${CSI}49m`).join("") + "\r\n",
      [0, 7, 8, 15, 16, 52, 88, 124, 160, 196, 202, 208, 214, 220, 226, 232, 244, 255].map((c) => `${CSI}38;5;${c}m#${CSI}48;5;${255 - c}m.${CSI}0m`).join("") + "\r\n",
      `${CSI}38;2;255;100;0mtruecolor fg${CSI}0m ${CSI}48;2;10;20;30mtruecolor bg${CSI}0m ${CSI}1;3;4;38;5;45;48;2;40;0;40mall at once${CSI}0m\r\n`,
      `${CSI}38:2::1:2:3mcolon rgb${CSI}m ${CSI}38:5:99mcolon 256${CSI}m ${CSI}48:2:9:8:7mno colorspace${CSI}m\r\n`,
      { snap: true },
      `${CSI}1;31mred bold ${CSI}32mgreen still bold ${CSI}0mreset\r\n$ ${CSI}44m`,
    ],
  },
  {
    name: "cursor",
    steps: [
      `${CSI}2J${CSI}H`, "line one\r\nline two\r\nline three\r\nline four\r\nline five\r\n",
      `${CSI}2;6Hinserted${CSI}3;1H${CSI}2Kreplaced three`, `${CSI}4;6H${CSI}K`, `${CSI}5;1H${CSI}3@>>>`, `${CSI}1;6H${CSI}2P`,
      `${CSI}10;20Hat 10,20${CSI}A${CSI}5Dup-left${CSI}2B${CSI}3Cdown-right`,
      `${CSI}12;1Ha\tb\tc\tend`, `${CSI}14;1H` + "w".repeat(95),
      { snap: true },
      `${CSI}17;22r${CSI}17;1Hregion 1\r\nregion 2\r\nregion 3\r\nregion 4\r\nregion 5\r\nregion 6\r\nregion 7\r\nregion 8${CSI}r`,
      `${CSI}24;1Hbottom${CSI}7;40H${ESC}7${CSI}8;1Hsaved-restored${ESC}8*`, `${CSI}9;1H${CSI}1L(inserted line)`, `${CSI}6;3H`,
      { snap: true },
      `${CSI}3;5H${CSI}2M${CSI}20;1H${CSI}3S${CSI}2T${CSI}5;10H${CSI}4X${CSI}1J${CSI}18;30H${CSI}0J`,
      `${CSI}2;2Hx${CSI}5b${CSI}3;1H\t\t${CSI}Z*${CSI}2I*${CSI}3g${CSI}4;1H\tfar${CSI}5;5H${ESC}H${CSI}6;1H\tstop`,
    ],
  },
  {
    name: "alt",
    steps: [
      "$ before the app\r\nsome shell output\r\n$ app\r\n",
      `${CSI}?1049h${CSI}?25l${CSI}?1h${CSI}?2004h${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?1004h`,
      `${CSI}H${CSI}2J${CSI}44;97m` + " Title bar".padEnd(80) + `${CSI}0m`,
      `${CSI}3;3H${CSI}1mheading${CSI}0m${CSI}5;3H┌${"─".repeat(30)}┐${CSI}6;3H│ ${CSI}32mok${CSI}0m${" ".repeat(27)}│${CSI}7;3H└${"─".repeat(30)}┘`,
      `${CSI}24;1H${CSI}7m status: ready ${CSI}0m${CSI}10;5H> typing here`,
    ],
  },
  {
    name: "alt-exit",
    steps: [
      "$ first\r\noutput a\r\noutput b\r\n$ app\r\n", `${CSI}?1049h${CSI}H${CSI}2Jfull screen app${CSI}5;5Hmore`,
      { snap: true }, `${CSI}?1049l`, "after the app\r\n$ ",
      { snap: true }, `${CSI}?47h47 screen${CSI}?47l${CSI}?1047hcleared on leave${CSI}?1047l${CSI}?1048h${CSI}9;9Hmoved${CSI}?1048l!`,
    ],
  },
  {
    name: "wide",
    steps: [
      "日本語のテキスト and ascii\r\n", "emoji: 😀 🎉 👍🏽 ok\r\n", "combining: é ä ñ done\r\n", "türkçe: İstanbul ığüşöç ĞÜŞİÖÇ\r\n",
      "x".repeat(79) + "漢" + "after-wrap\r\n", `${CSI}31m赤${CSI}32m緑${CSI}34m青${CSI}0m\r\n`, "box ┌─┬─┐ │ │ └─┴─┘ ■□▲△\r\n",
      { snap: true },
      `overwrite: 全角全角${CSI}6D${CSI}1CX\r\n`, `́lonely mark, ${"y".repeat(60)}末́端\r\n$ `,
      `${CSI}4h挿入${CSI}4l${CSI}2D${CSI}P${CSI}@`,
    ],
  },
  {
    name: "attrs-extra",
    steps: [
      `${CSI}9mstrike${CSI}29m ${CSI}5mblink${CSI}25m ${CSI}8mhidden${CSI}28m ${CSI}21mdouble${CSI}24m ${CSI}4:3mcurly${CSI}24m ${CSI}53moverline${CSI}55m\r\n`,
      `${CSI}4;58;5;196mred underline${CSI}0m ${ESC}]8;;https://example.test/x${ESC}\\link text${ESC}]8;;${ESC}\\ plain\r\n`,
      { snap: true },
      `${CSI}4:0mnone${CSI}4:5mdashed${CSI}59m${CSI}4:mempty${CSI}m ${ESC}]8;id=a;https://example.test/y\x07two\r\nlines${ESC}]8;;\x07 after\r\n`,
      `${CSI}58:2::10:20:30mcolor only${CSI}m ${CSI}1;2;3;4;5;7;8;9;53mall${CSI}22;23;24;25;27;28;29;55mnone\r\n$ `,
    ],
  },
  {
    name: "modes",
    steps: [
      `${ESC}]0;window title${ESC}\\`, "$ app\r\n",
      `${CSI}?1004h${CSI}?2004h${CSI}?1003h${CSI}?1006h${CSI}?1h${ESC}=${CSI}5 q${CSI}?12h${CSI}4h`, "prompt> ",
      { snap: true }, `${CSI}4l${CSI}?6h${CSI}?45h${CSI}?7l${CSI}?9h${CSI}?66l${CSI}?1016h${CSI}?25l`, "x".repeat(100),
      { snap: true }, `${CSI}!p`, { snap: true }, `${CSI}?1006h${CSI}?25l${ESC}c`, "after reset",
    ],
  },
  {
    name: "scrollback",
    steps: [
      Array.from({ length: 300 }, (_, i) => `${CSI}${31 + (i % 6)}mline ${String(i).padStart(3, "0")}${CSI}0m ${"·".repeat(i % 50)}\r\n`).join(""),
      "$ ",
    ],
  },
  {
    name: "scrollback-full",
    steps: [
      Array.from({ length: 1200 }, (_, i) => `${i} ${"x".repeat(i % 90)}\r\n`).join(""), { snap: true },
      `${CSI}3J`, { snap: true }, `${CSI}2J${CSI}H${CSI}41m${CSI}K`, "top",
    ],
  },
  {
    name: "background-erase",
    steps: [
      `${CSI}44m${CSI}2J${CSI}3;3Hon blue${CSI}K${CSI}5;1H${CSI}42m${CSI}10X${CSI}6;70H${CSI}45mnear the edge${CSI}0m\r\n`,
      `${CSI}43m\r\n\r\n${CSI}0mplain${CSI}46m${CSI}1K${CSI}10;1H${CSI}100m${" ".repeat(80)}${CSI}0m`,
      { snap: true }, `${CSI}41m` + "\r\n".repeat(30) + `${CSI}0m$ `,
    ],
  },
  {
    name: "charsets",
    steps: [
      `${ESC}(0lqqqk\r\nx   x\r\nmqqqj${ESC}(B plain\r\n`, `${ESC})0\x0elqk\x0f lqk ${ESC}(A#${ESC}(B#\r\n`,
      `${ESC}7${ESC}(0${ESC}8q${ESC}(0q${ESC}%@q ${ESC}*0${ESC}nq${ESC}o${ESC}(Kq[\\]\r\n$ `,
    ],
  },
  {
    name: "resize",
    cols: 40,
    rows: 10,
    steps: [
      Array.from({ length: 14 }, (_, i) => `${i}: ${"abcdefghij".repeat(1 + (i % 6))}\r\n`).join("") + "$ tail",
      { snap: true }, { resize: [60, 12] }, { snap: true }, { resize: [20, 6] }, { snap: true },
      "more after shrink 漢字漢字漢字漢字漢字漢字\r\n", { resize: [33, 9] }, { snap: true }, { resize: [80, 24] },
    ],
  },
  {
    name: "resize-alt",
    cols: 30,
    rows: 8,
    steps: [
      "shell line that is longer than thirty cells wide\r\n$ ", `${CSI}?1049h${CSI}2J${CSI}H` + "A".repeat(30) + `${CSI}4;1H` + "B".repeat(30) + `${CSI}8;1Hlast`,
      { resize: [20, 6] }, { snap: true }, { resize: [44, 9] }, { snap: true }, `${CSI}?1049l`,
    ],
  },
];

// ---- captured sessions -----------------------------------------------------

function captured() {
  return readdirSync(join(here, "captures")).filter((f) => f.endsWith(".bin")).sort().map((file) => {
    const bytes = readFileSync(join(here, "captures", file));
    const steps = [];
    // A PTY read ends anywhere: cut on a fixed stride, never inside a character.
    let at = 0;
    while (at < bytes.length) {
      let end = Math.min(bytes.length, at + 997);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
      steps.push(bytes.subarray(at, end).toString("utf8"));
      if (steps.length % 3 === 0) steps.push({ snap: true });
      at = end;
    }
    return { name: `captured-${file.replace(/\.bin$/, "")}`, steps };
  });
}

// ---- generated sessions ----------------------------------------------------

function rng(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["a", "ab", "hello", "x".repeat(7), " ", "  ", "$ ", "~", "é", "́", "漢", "漢字", "😀", "ı", "ğ", "—", "┌─┐", "​", "q", "lqk", "#[]"];
const SGR = [0, 1, 2, 3, 4, 5, 7, 8, 9, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 37, 39, 40, 44, 47, 49, 53, 55, 59, 90, 97, 100, 107, "38;5;1", "38;5;200", "48;5;15", "48;5;17", "38;2;1;2;3", "48;2;200;100;0", "4:0", "4:2", "4:3", "58;5;9", "58;2;1;1;1", "38:2::9:9:9", ""];
const PRIVATE_MODES = [1, 6, 7, 9, 12, 25, 45, 47, 66, 1000, 1002, 1003, 1004, 1006, 1016, 1047, 1048, 1049, 2004, 2026];
const CSI_FINALS = ["@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "P", "S", "T", "X", "Z", "`", "a", "b", "d", "e", "f", "g", "r", "s", "u", " @", " A", "'}", "'~", '"q', "?J", "?K"];
const ESCAPES = ["7", "8", "D", "E", "H", "M", "=", ">", "(0", "(B", ")0", "(A", "*0", "+0", "n", "o", "|", "}", "~", "#8", "%G", "\\"];

function generated(count, seedValue) {
  const next = rng(seedValue);
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const small = () => pick([0, 1, 1, 2, 2, 3, 4, 5, 7, 10, 30, 99]);
  const param = () => (next() < 0.25 ? "" : String(small()));

  const chunk = (cols, rows) => {
    const kind = next();
    if (kind < 0.3) return pick(WORDS).repeat(1 + int(3));
    if (kind < 0.36) return pick(["x", "wide漢", "é ", "-"]).repeat(int(cols + 6));
    if (kind < 0.46) return pick(["\r\n", "\r\n", "\n", "\r", "\b", "\t", "\x0e", "\x0f", "\x07", "\x0b", "\x0c", "\x7f", "\x00"]);
    if (kind < 0.6) return `${CSI}${Array.from({ length: 1 + int(3) }, () => pick(SGR)).join(";")}m`;
    if (kind < 0.7) return `${CSI}${1 + int(rows + 1)};${1 + int(cols + 2)}H`;
    if (kind < 0.84) {
      const final = pick(CSI_FINALS);
      const n = int(3);
      return `${CSI}${Array.from({ length: n }, param).join(";")}${final}`;
    }
    if (kind < 0.9) return `${CSI}?${pick(PRIVATE_MODES)}${next() < 0.2 ? `;${pick(PRIVATE_MODES)}` : ""}${pick(["h", "l"])}`;
    if (kind < 0.92) return `${CSI}${pick([4, 20, 2])}${pick(["h", "l"])}`;
    if (kind < 0.96) return ESC + pick(ESCAPES);
    if (kind < 0.975) return next() < 0.6 ? `${ESC}]8;${pick(["", "id=k"])};https://example.test/${int(3)}${pick(["\x07", `${ESC}\\`])}` : `${ESC}]8;;${pick(["\x07", `${ESC}\\`])}`;
    if (kind < 0.985) return pick([`${ESC}]0;title\x07`, `${ESC}]2;t${ESC}\\`, `${ESC}]52;c;AAAA\x07`, `${ESC}P$qm${ESC}\\`, `${ESC}_apc${ESC}\\`, `${ESC}]8;;unterminated`, `${CSI}1;2`, `${CSI}>c`, `${CSI}6n`, `${CSI}!p`]);
    if (kind < 0.99) return `${CSI}${1 + int(rows)};${1 + int(rows + 2)}r`;
    return pick([`${ESC}c`, `${CSI}3J`, `${CSI}2J`, `${CSI}!p`]);
  };

  const cases = [];
  for (let i = 0; i < count; i++) {
    const cols = pick([2, 5, 8, 10, 12, 20, 20, 33, 40, 80]);
    const rows = pick([1, 2, 3, 4, 5, 6, 8, 10, 24]);
    const steps = [];
    const length = 5 + int(60);
    let size = [cols, rows];
    // Some sessions scroll a lot first, so later steps act on a full scrollback.
    if (next() < 0.04) steps.push(Array.from({ length: 1000 + int(60) }, (_, n) => `${n % 10}${"=".repeat(n % (cols + 3))}\r\n`).join(""));
    for (let s = 0; s < length; s++) {
      const r = next();
      if (r < 0.03) {
        size = [pick([2, 3, 7, 9, 10, 16, 20, 21, 40, 41, 80]), pick([1, 2, 3, 5, 6, 7, 10, 24])];
        steps.push({ resize: size });
      } else if (r < 0.08) {
        steps.push({ snap: true });
      } else {
        let text = "";
        for (let n = 1 + int(6); n > 0; n--) text += chunk(size[0], size[1]);
        steps.push(text);
      }
    }
    cases.push({ name: `generated-${seedValue}-${i}`, cols, rows, steps });
  }
  return cases;
}

// ---- run -------------------------------------------------------------------

const createScreenMirror = await loadMirror();
// xterm reports sequences it rejects on the console; they are part of the input here.
console.error = () => {};

// The terminal behind the mirror being run, to look at its row lists.
let terminal;
xtermHeadless.Terminal = class extends xtermHeadless.Terminal {
  constructor(options) {
    super(options);
    terminal = this;
  }
};

// One state is left out of the vectors: xterm losing track of the screen's
// rows. Growing the screen while the alternate screen holds more rows than fit
// (possible after the window shrank while that screen was off) drops rows off
// a full list without moving the screen's top, so the last rows wrap around
// the list onto the first ones and the snapshot comes out shuffled. The Rust
// mirror keeps the screen whole instead (crates/eos-pty/src/screen/buffer.rs).
// Everything written so far is parsed before the next step: steps apply in order.
const settled = () => new Promise((done) => terminal.write("", done));

function lostRows() {
  const { normal, alt } = terminal._core.buffers;
  return [normal, alt].some((b) => b.lines.length > 0 && b.ybase + terminal.rows > b.lines.length);
}

async function run(session) {
  const cols = session.cols ?? 80;
  const rows = session.rows ?? 24;
  const mirror = createScreenMirror(cols, rows);
  const steps = [];
  let lost = false;
  for (const step of [...session.steps, { snap: true }]) {
    if (typeof step === "string") {
      mirror.write(step);
      steps.push({ write: step });
    } else if (step.resize) {
      await settled();
      mirror.resize(step.resize[0], step.resize[1]);
      steps.push({ resize: step.resize });
    } else {
      steps.push({ snapshot: await mirror.snapshot() });
    }
    await settled();
    lost ||= lostRows();
  }
  mirror.dispose();
  return lost ? null : { name: session.name, cols, rows, steps };
}

const sessions = [...scripted, ...captured(), ...generated(fuzzCount, seed)];
const vectors = [];
let skipped = 0;
for (const session of sessions) {
  const vector = await run(session);
  if (vector) vectors.push(vector);
  else skipped++;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: "manager/services/pty/screenMirror.ts (@xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0)", seed, vectors }) + "\n");
console.log(`${vectors.length} sessions (${scripted.length} scripted, ${sessions.length - scripted.length - fuzzCount} captured, ${fuzzCount} generated; ${skipped} left out: xterm lost its rows) → ${out}`);
