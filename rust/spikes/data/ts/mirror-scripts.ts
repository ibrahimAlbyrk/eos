// Scripted terminal sessions for the screen-mirror comparison: raw bytes a PTY
// could have produced, written to <out>/<name>.bin. All content is invented.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const ESC = "\x1b";
const CSI = `${ESC}[`;

const scripts: Record<string, string> = {
  // SGR: 16 colors, bright, 256, truecolor, attributes, resets.
  colors: [
    `plain ${CSI}1mbold${CSI}22m ${CSI}2mdim${CSI}22m ${CSI}3mitalic${CSI}23m ${CSI}4munder${CSI}24m ${CSI}7minverse${CSI}27m ${CSI}9mstrike${CSI}29m\r\n`,
    ...[30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map((c) => `${CSI}${c}m${c}${CSI}39m `), "\r\n",
    ...[40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103].map((c) => `${CSI}${c}m ${c} ${CSI}49m`), "\r\n",
    ...[16, 52, 88, 124, 160, 196, 202, 208, 214, 220, 226, 232, 244, 255].map((c) => `${CSI}38;5;${c}m#${CSI}48;5;${255 - c}m.${CSI}0m`), "\r\n",
    `${CSI}38;2;255;100;0mtruecolor fg${CSI}0m ${CSI}48;2;10;20;30mtruecolor bg${CSI}0m ${CSI}1;3;4;38;5;45;48;2;40;0;40mall at once${CSI}0m\r\n`,
    `${CSI}1;31mred bold ${CSI}32mgreen still bold ${CSI}0mreset\r\n$ `,
  ].join(""),

  // Cursor addressing, erasing, insert/delete, scroll region, tabs, wrap.
  cursor: [
    `${CSI}2J${CSI}H`, "line one\r\nline two\r\nline three\r\nline four\r\nline five\r\n",
    `${CSI}2;6Hinserted${CSI}3;1H${CSI}2Kreplaced three`, `${CSI}4;6H${CSI}K`, `${CSI}5;1H${CSI}3@>>>`, `${CSI}1;6H${CSI}2P`,
    `${CSI}10;20Hat 10,20${CSI}A${CSI}5Dup-left${CSI}2B${CSI}3Cdown-right`,
    `${CSI}12;1Ha\tb\tc\tend`, `${CSI}14;1H` + "w".repeat(95), // wraps at column 80
    `${CSI}17;22r${CSI}17;1Hregion 1\r\nregion 2\r\nregion 3\r\nregion 4\r\nregion 5\r\nregion 6\r\nregion 7\r\nregion 8${CSI}r`,
    `${CSI}24;1Hbottom${CSI}7;40H${ESC}7${CSI}8;1Hsaved-restored${ESC}8*`, `${CSI}9;1H${CSI}1L(inserted line)`, `${CSI}6;3H`,
  ].join(""),

  // A TUI that stays on the alternate screen with the modes Claude Code sets.
  alt: [
    "$ before the app\r\nsome shell output\r\n$ app\r\n",
    `${CSI}?1049h${CSI}?25l${CSI}?1h${CSI}?2004h${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?1004h`,
    `${CSI}H${CSI}2J${CSI}44;97m` + " Title bar".padEnd(80) + `${CSI}0m`,
    `${CSI}3;3H${CSI}1mheading${CSI}0m${CSI}5;3H┌${"─".repeat(30)}┐${CSI}6;3H│ ${CSI}32mok${CSI}0m${" ".repeat(27)}│${CSI}7;3H└${"─".repeat(30)}┘`,
    `${CSI}24;1H${CSI}7m status: ready ${CSI}0m${CSI}10;5H> typing here`,
  ].join(""),

  // Enters the alternate screen, draws, and leaves: the primary screen must be back.
  "alt-exit": [
    "$ first\r\noutput a\r\noutput b\r\n$ app\r\n", `${CSI}?1049h${CSI}H${CSI}2Jfull screen app${CSI}5;5Hmore`, `${CSI}?1049l`, "after the app\r\n$ ",
  ].join(""),

  // Wide characters, emoji, combining marks, a wide char at the right margin.
  wide: [
    "日本語のテキスト and ascii\r\n", "emoji: 😀 🎉 👍🏽 ok\r\n", "combining: é ä ñ done\r\n", "türkçe: İstanbul ığüşöç ĞÜŞİÖÇ\r\n",
    "x".repeat(79) + "漢" + "after-wrap\r\n", `${CSI}31m赤${CSI}32m緑${CSI}34m青${CSI}0m\r\n`, "box ┌─┬─┐ │ │ └─┴─┘ ■□▲△\r\n",
    `overwrite: 全角全角${CSI}6D${CSI}1CX\r\n$ `,
  ].join(""),

  // Attributes beyond the basic five.
  "attrs-extra": [
    `${CSI}9mstrike${CSI}29m ${CSI}5mblink${CSI}25m ${CSI}8mhidden${CSI}28m ${CSI}21mdouble${CSI}24m ${CSI}4:3mcurly${CSI}24m ${CSI}53moverline${CSI}55m\r\n`,
    `${CSI}4;58;5;196mred underline${CSI}0m ${ESC}]8;;https://example.test/x${ESC}\\link text${ESC}]8;;${ESC}\\ plain\r\n$ `,
  ].join(""),

  // Modes set on the primary screen and left on.
  "modes-extra": [
    `${ESC}]0;window title${ESC}\\`, "$ app\r\n", `${CSI}?1004h${CSI}?2004h${CSI}?1003h${CSI}?1006h${CSI}?1h${ESC}=${CSI}5 q${CSI}?12h${CSI}4h`, "prompt> ",
  ].join(""),

  // More output than fits: 300 lines through a 24-row screen, colors included.
  scrollback: [
    ...Array.from({ length: 300 }, (_, i) => `${CSI}${31 + (i % 6)}mline ${String(i).padStart(3, "0")}${CSI}0m ${"·".repeat(i % 50)}\r\n`), "$ ",
  ].join(""),
};

for (const [name, text] of Object.entries(scripts)) writeFileSync(join(out, `${name}.bin`), Buffer.from(text, "utf8"));
console.log(JSON.stringify(Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, Buffer.byteLength(v)]))));
