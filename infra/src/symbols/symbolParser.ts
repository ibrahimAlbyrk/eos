// The symbol parser process. TreeSitterSymbolIndex forks it to parse files with
// web-tree-sitter (WASM grammars from @vscode/tree-sitter-wasm) + each
// language's tags.scm; each request is answered with packed occurrences.
// tree-sitter's WASM memory grows to fit the largest tree parsed and never
// shrinks, so it lives in this process, which the index stops when idle.
//
// Language participation is DATA: a language works iff its grammar WASM + a
// tags.scm are both present. A missing/broken grammar is a logged gap, not a
// crash — the UI falls back to filename search.

import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Parser, Language, Query } from "web-tree-sitter";
import type { SymbolOccurrence, SymbolRole } from "../../../core/src/ports/SymbolIndex.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import { GRAMMARS } from "./languages.ts";

export interface ParseRequest {
  id: number;
  paths: string[]; // absolute, each one indexable()
  maxFiles: number;
  maxFileBytes: number;
}

export interface ParseReply {
  id: number;
  paths: string[];
  names: string[];
  kinds: string[];
  // 6 ints per occurrence, in file then capture order: path, name and kind
  // (indexes into the tables above), role (1 = definition), line, column.
  occ: Int32Array;
  capped: number; // participating files skipped past maxFiles
  notes: { msg: string; meta: Record<string, unknown> }[];
}

interface LoadedGrammar {
  lang: Language;
  query: Query;
}

type Occurrence = Omit<SymbolOccurrence, "lineText">;

// Bytes per line above which a file is minified or generated, not written
// (hand-written source averages well under 100).
const MINIFIED_BYTES_PER_LINE = 300;

const extToGrammar = new Map<string, LoadedGrammar>();
const notes: ParseReply["notes"] = [];
let grammarsReady: Promise<void> | null = null;
let parser: Parser | null = null;

async function loadGrammars(): Promise<void> {
  const wasmDir = dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm"));
  const scmDir = fileURLToPath(new URL("./grammars/", import.meta.url));
  await Parser.init();
  for (const def of GRAMMARS) {
    try {
      const lang = await Language.load(join(wasmDir, def.wasm));
      const query = new Query(lang, def.scm.map((s) => readFileSync(join(scmDir, `${s}.scm`), "utf8")).join("\n"));
      for (const ext of def.exts) extToGrammar.set(ext, { lang, query });
    } catch (e) {
      // A missing/broken grammar disables that language only — logged gap, not
      // a crash. Its files fall back to filename search in the UI.
      notes.push({ msg: `symbol grammar unavailable: ${def.id}`, meta: { error: errMsg(e) } });
    }
  }
}

function parseAll(req: ParseRequest): ParseReply {
  parser ??= new Parser();
  const reply: ParseReply = { id: req.id, paths: [], names: [], kinds: [], occ: new Int32Array(), capped: 0, notes: notes.splice(0) };
  const ids = { names: new Map<string, number>(), kinds: new Map<string, number>() };
  const intern = (table: "names" | "kinds", s: string): number => {
    let i = ids[table].get(s);
    if (i === undefined) {
      i = reply[table].push(s) - 1;
      ids[table].set(s, i);
    }
    return i;
  };
  const occ: number[] = [];
  let parsed = 0;
  for (const abs of req.paths) {
    const grammar = extToGrammar.get(extname(abs).toLowerCase());
    if (!grammar) continue; // its grammar didn't load
    if (parsed >= req.maxFiles) {
      reply.capped++;
      continue;
    }
    const found = parseFile(parser, grammar, abs, req.maxFileBytes);
    if (found === null) continue;
    parsed++;
    if (!found.length) continue;
    const p = reply.paths.push(abs) - 1;
    for (const o of found) occ.push(p, intern("names", o.name), intern("kinds", o.kind), o.role === "definition" ? 1 : 0, o.line, o.column);
  }
  reply.occ = Int32Array.from(occ);
  return reply;
}

// Parse one file into occurrences, or null if it is unreadable / binary /
// oversized / minified.
function parseFile(parser: Parser, grammar: LoadedGrammar, abs: string, maxFileBytes: number): Occurrence[] | null {
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    return null;
  }
  if (size > maxFileBytes) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8192).includes(0)) return null; // binary
  let lines = 1;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  if (buf.length / lines > MINIFIED_BYTES_PER_LINE) return null;
  parser.setLanguage(grammar.lang);
  let tree;
  try {
    tree = parser.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  if (!tree) return null;
  const out: Occurrence[] = [];
  try {
    for (const match of grammar.query.matches(tree.rootNode)) {
      let name: string | undefined;
      let role: SymbolRole | undefined;
      let kind = "";
      let row = 0;
      let column = 0;
      for (const cap of match.captures) {
        if (cap.name === "name") {
          name = cap.node.text;
          row = cap.node.startPosition.row;
          column = cap.node.startPosition.column;
        } else if (cap.name.startsWith("definition.")) {
          role = "definition";
          kind = cap.name.slice("definition.".length);
        } else if (cap.name.startsWith("reference.")) {
          role = "reference";
          kind = cap.name.slice("reference.".length);
        }
      }
      if (!name || !role) continue;
      out.push({ name, kind, role, path: abs, line: row + 1, column: column + 1 });
    }
  } finally {
    tree.delete?.();
  }
  return out;
}

// Requests are answered in arrival order: each waits on the same grammar load,
// then parses synchronously.
process.on("message", (req: ParseRequest) => {
  grammarsReady ??= loadGrammars();
  void grammarsReady.then(() => process.send!(parseAll(req)));
});
process.on("disconnect", () => process.exit(0));
