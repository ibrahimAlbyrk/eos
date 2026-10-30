// TreeSitterSymbolIndex — the syntactic (name-matched) SymbolIndex adapter.
//
// Parses the git-scoped candidate files of a root in-process with web-tree-sitter
// (WASM grammars from @vscode/tree-sitter-wasm) + each language's tags.scm, and
// serves go-to-definition / find-references / symbol-search by name matching.
// tree-sitter is MIT; no child process, no bundled CLI binary to supervise.
//
// Design (dim03 §2b):
//  - Candidate set = the same listCandidateFiles() filename search uses (DRY).
//  - Reads files from disk daemon-side with the same binary sniff as /fs/read.
//    Vendored, minified and >512 KB files stay out (filename search keeps them).
//  - In-memory per root: Map<name, SymbolOccurrence[]> + a per-file index for
//    incremental invalidation off the fs:change bus. lineText is read from disk
//    for the rows a query returns, so the index never holds the source lines.
//  - The build yields to the event loop every SLICE_MS of parsing.
//  - Lazy ensureIndexed keyed by root; coarse dirty-and-rebuild for stale roots;
//    LRU cap + release(root) bound multi-root memory.
//  - Language participation is DATA: a language works iff its grammar WASM + a
//    tags.scm are both present. A missing/broken grammar is a logged gap, not a
//    crash — the UI falls back to filename search.

import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Parser, Language, Query } from "web-tree-sitter";
import type {
  SymbolIndex,
  SymbolOccurrence,
  SymbolRole,
} from "../../../core/src/ports/SymbolIndex.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import { listCandidateFiles } from "../filesystem/gitCandidateFiles.ts";

// Priority set (dim03 §4): TS/JS, Python, Go, Rust, Java. TS/TSX inherit the JS
// tags (the upstream TS tags.scm is the TS-only delta), so their `scm` composes
// javascript + typescript. wasm names match @vscode/tree-sitter-wasm/wasm/.
interface GrammarDef {
  id: string;
  wasm: string;
  scm: string[];
  exts: string[];
}

const GRAMMARS: GrammarDef[] = [
  { id: "javascript", wasm: "tree-sitter-javascript.wasm", scm: ["javascript"], exts: [".js", ".mjs", ".cjs", ".jsx"] },
  { id: "typescript", wasm: "tree-sitter-typescript.wasm", scm: ["javascript", "typescript"], exts: [".ts", ".mts", ".cts"] },
  { id: "tsx", wasm: "tree-sitter-tsx.wasm", scm: ["javascript", "typescript"], exts: [".tsx"] },
  { id: "python", wasm: "tree-sitter-python.wasm", scm: ["python"], exts: [".py", ".pyi"] },
  { id: "go", wasm: "tree-sitter-go.wasm", scm: ["go"], exts: [".go"] },
  { id: "rust", wasm: "tree-sitter-rust.wasm", scm: ["rust"], exts: [".rs"] },
  { id: "java", wasm: "tree-sitter-java.wasm", scm: ["java"], exts: [".java"] },
];

interface LoadedGrammar {
  id: string;
  lang: Language;
  query: Query;
}

interface RootIndex {
  byName: Map<string, SymbolOccurrence[]>; // all occurrences keyed by bare name
  byFile: Map<string, SymbolOccurrence[]>; // occurrences keyed by abs path (invalidate swap)
  lastUsed: number; // LRU cursor
}

export interface TreeSitterSymbolIndexDeps {
  // Defaults to the shared git-scoped candidate set (relative POSIX paths).
  listFiles?: (root: string) => Promise<string[]>;
  // WASM grammar dir; defaults to @vscode/tree-sitter-wasm/wasm.
  wasmDir?: string;
  // Max resident root indexes before LRU eviction (multi-root memory bound).
  maxResidentRoots?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  notify?: (msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_FILE_BYTES = 512 * 1024;
const LINE_TEXT_MAX = 500;
const SLICE_MS = 10;
// Conventional homes of code a project ships but doesn't write.
const VENDOR_DIRS = new Set(["vendor", "vendors", "vendored", "third_party", "third-party", "thirdparty", "node_modules", "bower_components"]);
// Bytes per line above which a file is minified or generated, not written
// (hand-written source averages well under 100).
const MINIFIED_BYTES_PER_LINE = 300;

export class TreeSitterSymbolIndex implements SymbolIndex {
  private readonly listFiles: (root: string) => Promise<string[]>;
  private readonly wasmDir: string;
  private readonly scmDir: string;
  private readonly maxResidentRoots: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly notify: (msg: string, meta?: Record<string, unknown>) => void;

  private readonly indexes = new Map<string, RootIndex>();
  private readonly building = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly scmCache = new Map<string, string>();
  private readonly extToGrammar = new Map<string, LoadedGrammar>();
  private grammarsReady: Promise<void> | null = null;
  private clock = 0;

  constructor(deps: TreeSitterSymbolIndexDeps = {}) {
    const require = createRequire(import.meta.url);
    this.listFiles = deps.listFiles ?? listCandidateFiles;
    // Resolve the bundled WASM dir from the package's main (wasm/tree-sitter.js).
    this.wasmDir = deps.wasmDir ?? dirname(require.resolve("@vscode/tree-sitter-wasm"));
    this.scmDir = fileURLToPath(new URL("./grammars/", import.meta.url));
    this.maxResidentRoots = deps.maxResidentRoots ?? 6;
    this.maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxFiles = deps.maxFiles ?? 20000;
    this.notify = deps.notify ?? (() => {});
  }

  // ---- SymbolQuery (read surface) -----------------------------------------

  async definitions(root: string, name: string, fromPath?: string): Promise<SymbolOccurrence[]> {
    await this.ensureIndexed(root);
    const occ = this.indexes.get(root)?.byName.get(name) ?? [];
    const defs = occ.filter((o) => o.role === "definition");
    if (!fromPath || defs.length < 2) return withLineText(defs);
    // Rank a same-file, then same-dir definition first — the tier is syntactic,
    // so this is a heuristic for the common case, not resolution.
    const fromDir = dirname(fromPath);
    return withLineText(defs.sort((a, b) => this.proximity(a.path, fromPath, fromDir) - this.proximity(b.path, fromPath, fromDir)));
  }

  async references(root: string, name: string): Promise<SymbolOccurrence[]> {
    await this.ensureIndexed(root);
    // The full occurrence list — definitions and references both (name-matched).
    return withLineText(this.indexes.get(root)?.byName.get(name) ?? []);
  }

  // Enumerate every definition in one file with a single parse — reuses the same
  // tags extraction as the whole-root build, without forcing a full-root index
  // (CodeLens on one open file shouldn't index the whole repo).
  async definitionsInFile(root: string, path: string): Promise<SymbolOccurrence[]> {
    await this.ensureGrammars();
    const parser = new Parser();
    try {
      const occ = this.parseFile(parser, root, path);
      return withLineText((occ ?? []).filter((o) => o.role === "definition"));
    } finally {
      parser.delete?.();
    }
  }

  async searchSymbols(root: string, query: string, limit: number): Promise<SymbolOccurrence[]> {
    await this.ensureIndexed(root);
    const idx = this.indexes.get(root);
    if (!idx) return [];
    const q = query.toLowerCase();
    const scored: { occ: SymbolOccurrence; score: number }[] = [];
    for (const [name, occ] of idx.byName) {
      const score = scoreName(name.toLowerCase(), q);
      if (!score) continue;
      const defs = occ.filter((o) => o.role === "definition");
      const pool = defs.length ? defs : occ.slice(0, 1);
      for (const o of pool) scored.push({ occ: o, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.occ.name.localeCompare(b.occ.name) || a.occ.path.localeCompare(b.occ.path),
    );
    return withLineText(scored.slice(0, limit).map((s) => s.occ));
  }

  // ---- SymbolIndexLifecycle -----------------------------------------------

  async ensureIndexed(root: string): Promise<void> {
    const existing = this.indexes.get(root);
    if (existing && !this.dirty.has(root)) {
      existing.lastUsed = ++this.clock;
      return;
    }
    let p = this.building.get(root);
    if (!p) {
      // Cleared up front: a markDirty while this build yields leaves its result stale.
      this.dirty.delete(root);
      p = this.build(root)
        .then((idx) => {
          this.indexes.set(root, idx);
          this.building.delete(root);
          this.evictIfNeeded();
        })
        .catch((e) => {
          this.building.delete(root);
          if (this.indexes.has(root)) this.dirty.add(root);
          throw e;
        });
      this.building.set(root, p);
    }
    await p;
    const idx = this.indexes.get(root);
    if (idx) idx.lastUsed = ++this.clock;
  }

  async invalidate(root: string, changedPaths: string[]): Promise<void> {
    // A build in flight may already have read these files' old content.
    await this.building.get(root)?.catch(() => {});
    const idx = this.indexes.get(root);
    if (!idx) return; // nothing resident to update
    await this.ensureGrammars();
    const parser = new Parser();
    const slice = timeSlicer();
    try {
      for (const abs of changedPaths) {
        await slice();
        this.removeFile(idx, abs);
        const occ = this.parseFile(parser, root, abs);
        if (occ && occ.length) {
          idx.byFile.set(abs, occ);
          for (const o of occ) this.pushOccurrence(idx.byName, o);
        }
      }
    } finally {
      parser.delete?.();
    }
  }

  release(root: string): void {
    this.indexes.delete(root);
    this.dirty.delete(root);
  }

  // ---- Concrete wiring helpers (not on the port) --------------------------

  // Resident roots, and those being built — the container routes an
  // fs:change/git:change batch to the subset of roots it actually touches.
  residentRoots(): string[] {
    return [...new Set([...this.indexes.keys(), ...this.building.keys()])];
  }

  // Coarse freshness fallback: mark a resident root stale so the next query does
  // a full rebuild. Driven by the recursive git-state watcher for edits the
  // shallow explorer watcher never emits (dim03 §2b / §5).
  markDirty(root: string): void {
    if (this.indexes.has(root) || this.building.has(root)) this.dirty.add(root);
  }

  // ---- internals ----------------------------------------------------------

  private proximity(path: string, fromPath: string, fromDir: string): number {
    if (path === fromPath) return 0;
    if (dirname(path) === fromDir) return 1;
    return 2;
  }

  private removeFile(idx: RootIndex, abs: string): void {
    const old = idx.byFile.get(abs);
    if (!old) return;
    for (const name of new Set(old.map((o) => o.name))) {
      const arr = idx.byName.get(name);
      if (!arr) continue;
      const kept = arr.filter((o) => o.path !== abs);
      if (kept.length) idx.byName.set(name, kept);
      else idx.byName.delete(name);
    }
    idx.byFile.delete(abs);
  }

  private pushOccurrence(byName: Map<string, SymbolOccurrence[]>, o: SymbolOccurrence): void {
    const arr = byName.get(o.name);
    if (arr) arr.push(o);
    else byName.set(o.name, [o]);
  }

  private async build(root: string): Promise<RootIndex> {
    await this.ensureGrammars();
    const byName = new Map<string, SymbolOccurrence[]>();
    const byFile = new Map<string, SymbolOccurrence[]>();
    const parser = new Parser();
    const slice = timeSlicer();
    let parsed = 0;
    let capped = 0;
    try {
      for (const rel of await this.listFiles(root)) {
        const abs = join(root, rel);
        if (!this.extToGrammar.has(extname(abs).toLowerCase())) continue; // not a participating language
        if (parsed >= this.maxFiles) {
          capped++;
          continue;
        }
        await slice();
        const occ = this.parseFile(parser, root, abs);
        if (occ === null) continue;
        parsed++;
        if (!occ.length) continue;
        byFile.set(abs, occ);
        for (const o of occ) this.pushOccurrence(byName, o);
      }
    } finally {
      parser.delete?.();
    }
    if (capped > 0) this.notify("symbol index file cap hit — some files skipped", { root, cap: this.maxFiles, skipped: capped });
    return { byName, byFile, lastUsed: ++this.clock };
  }

  // Parse one file into occurrences, or null if it is not a participating
  // language / vendored / unreadable / binary / oversized / minified.
  private parseFile(parser: Parser, root: string, abs: string): SymbolOccurrence[] | null {
    const grammar = this.extToGrammar.get(extname(abs).toLowerCase());
    if (!grammar || isVendored(relative(root, abs))) return null;
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return null;
    }
    if (size > this.maxFileBytes) return null;
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
    const text = buf.toString("utf8");
    parser.setLanguage(grammar.lang);
    let tree;
    try {
      tree = parser.parse(text);
    } catch {
      return null;
    }
    if (!tree) return null;
    const out: SymbolOccurrence[] = [];
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

  private ensureGrammars(): Promise<void> {
    if (!this.grammarsReady) this.grammarsReady = this.loadGrammars();
    return this.grammarsReady;
  }

  private async loadGrammars(): Promise<void> {
    await Parser.init();
    for (const def of GRAMMARS) {
      try {
        const lang = await Language.load(join(this.wasmDir, def.wasm));
        const scmText = def.scm.map((s) => this.readScm(s)).join("\n");
        const query = new Query(lang, scmText);
        const loaded: LoadedGrammar = { id: def.id, lang, query };
        for (const ext of def.exts) this.extToGrammar.set(ext, loaded);
      } catch (e) {
        // A missing/broken grammar disables that language only — logged gap, not
        // a crash. Its files fall back to filename search in the UI.
        this.notify(`symbol grammar unavailable: ${def.id}`, { error: errMsg(e) });
      }
    }
  }

  private readScm(name: string): string {
    let text = this.scmCache.get(name);
    if (text === undefined) {
      text = readFileSync(join(this.scmDir, `${name}.scm`), "utf8");
      this.scmCache.set(name, text);
    }
    return text;
  }

  private evictIfNeeded(): void {
    while (this.indexes.size > this.maxResidentRoots) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [root, idx] of this.indexes) {
        if (idx.lastUsed < oldest) {
          oldest = idx.lastUsed;
          victim = root;
        }
      }
      if (victim === null) return;
      this.indexes.delete(victim);
      this.dirty.delete(victim);
      this.notify("symbol index evicted (LRU cap)", { root: victim, cap: this.maxResidentRoots });
    }
  }
}

// A vendor-dir segment under the root, or a minified file name.
function isVendored(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  const file = parts.pop() ?? "";
  return /\.min\.[^.]+$/i.test(file) || parts.some((p) => VENDOR_DIRS.has(p.toLowerCase()));
}

// Copies of `occ` with each row's source line, one read per file.
async function withLineText(occ: SymbolOccurrence[]): Promise<SymbolOccurrence[]> {
  const files = new Map<string, Promise<string[]>>();
  const linesOf = (path: string): Promise<string[]> => {
    let lines = files.get(path);
    if (!lines) {
      lines = readFile(path, "utf8").then((t) => t.split("\n"), () => []);
      files.set(path, lines);
    }
    return lines;
  };
  return Promise.all(
    occ.map(async (o) => {
      const line = (await linesOf(o.path))[o.line - 1] ?? "";
      return { ...o, lineText: line.length > LINE_TEXT_MAX ? line.slice(0, LINE_TEXT_MAX) : line };
    }),
  );
}

// Each call resolves at once until SLICE_MS of synchronous work has run since
// the last yield, then after a macrotask.
function timeSlicer(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await new Promise((r) => setImmediate(r));
    since = performance.now();
  };
}

// Symbol-name ranking, mirroring fs-shared.ts scoreMatch so symbol search ranks
// like filename search: exact > prefix > substring.
function scoreName(name: string, query: string): number {
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  return 0;
}
