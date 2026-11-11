// Compares two `mirror.ts state` dumps and prints what differs, by category.
import { readFileSync } from "node:fs";

const [aFile, bFile] = process.argv.slice(2);
const a = JSON.parse(readFileSync(aFile, "utf8"));
const b = JSON.parse(readFileSync(bFile, "utf8"));
const diffs: string[] = [];
const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
if (a.active !== b.active) diffs.push(`active buffer ${a.active} vs ${b.active}`);
if (!same(a.cursor, b.cursor)) diffs.push(`cursor ${JSON.stringify(a.cursor)} vs ${JSON.stringify(b.cursor)}`);
if (a.cursorHidden !== b.cursorHidden) diffs.push(`cursorHidden ${a.cursorHidden} vs ${b.cursorHidden}`);
if (a.mouseEncoding !== b.mouseEncoding) diffs.push(`mouseEncoding ${a.mouseEncoding} vs ${b.mouseEncoding}`);
for (const k of Object.keys(a.modes)) if (a.modes[k] !== b.modes[k]) diffs.push(`mode ${k} ${a.modes[k]} vs ${b.modes[k]}`);
function lines(name: string, x: any[] | null, y: any[] | null): void {
  if (!x || !y) { if (x !== y) diffs.push(`${name}: present on one side only`); return; }
  if (x.length !== y.length) diffs.push(`${name}: ${x.length} lines vs ${y.length}`);
  let text = 0, cells = 0, wrapped = 0, first = "";
  // Compare from the bottom: scrollback length may differ, the screen must not.
  for (let i = 1; i <= Math.min(x.length, y.length); i++) {
    const p = x[x.length - i], q = y[y.length - i];
    if (p.text !== q.text) { text++; first ||= `text at -${i}: ${JSON.stringify(p.text.slice(0, 60))} vs ${JSON.stringify(q.text.slice(0, 60))}`; }
    else if (p.cells !== q.cells) { cells++; first ||= `attrs at -${i} (${JSON.stringify(p.text.slice(0, 30))}): ${p.cells.slice(0, 90)} vs ${q.cells.slice(0, 90)}`; }
    if (p.wrapped !== q.wrapped) wrapped++;
  }
  if (text || cells) diffs.push(`${name}: ${text} lines differ in text, ${cells} in attributes; first ${first}`);
  if (wrapped) diffs.push(`${name}: ${wrapped} lines differ in the wrapped flag`);
}
lines("normal", a.normal.lines, b.normal.lines);
lines("alternate", a.alternate, b.alternate);
console.log(diffs.length ? diffs.map((d) => `    ${d}`).join("\n") : "    identical");
process.exit(diffs.length ? 1 : 0);
