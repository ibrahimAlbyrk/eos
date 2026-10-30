// TreeSitterSymbolIndex — the syntactic (name-matched) SymbolIndex adapter.
//
// Serves go-to-definition / find-references / symbol-search by name matching
// over tree-sitter tags. Parsing happens in the symbol parser process
// (symbolParser.ts), forked on demand and stopped after IDLE_MS without a
// request, so the daemon never holds tree-sitter's WASM memory.
//
// Design (dim03 §2b):
//  - Candidate set = the same listCandidateFiles() filename search uses (DRY).
//    Vendored, minified and >512 KB files stay out (filename search keeps them).
//  - In-memory per root: Map<name, SymbolOccurrence[]> + a per-file index for
//    incremental invalidation off the fs:change bus. lineText is read from disk
//    for the rows a query returns, so the index never holds the source lines.
//  - A parser reply is unpacked in SLICE_MS slices between event-loop turns.
//  - Lazy ensureIndexed keyed by root; coarse dirty-and-rebuild for stale roots;
//    LRU cap + release(root) bound multi-root memory.
//  - A parser process that dies fails the requests it held (logged); the routes
//    answer an error, the UI falls back to filename search, and the next request
//    forks a new one.

import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SymbolIndex,
  SymbolOccurrence,
} from "../../../core/src/ports/SymbolIndex.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import { listCandidateFiles } from "../filesystem/gitCandidateFiles.ts";
import { indexable } from "./languages.ts";
import type { ParseReply, ParseRequest } from "./symbolParser.ts";

interface RootIndex {
  byName: Map<string, SymbolOccurrence[]>; // all occurrences keyed by bare name
  byFile: Map<string, SymbolOccurrence[]>; // occurrences keyed by abs path (invalidate swap)
  lastUsed: number; // LRU cursor
}

type Notify = (msg: string, meta?: Record<string, unknown>) => void;

export interface TreeSitterSymbolIndexDeps {
  // Defaults to the shared git-scoped candidate set (relative POSIX paths).
  listFiles?: (root: string) => Promise<string[]>;
  // The parser process entry; defaults to symbolParser.ts beside this file.
  parserScript?: string;
  // Max resident root indexes before LRU eviction (multi-root memory bound).
  maxResidentRoots?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  notify?: Notify;
}

const MAX_FILE_BYTES = 512 * 1024;
const LINE_TEXT_MAX = 500;
const SLICE_MS = 10;
const IDLE_MS = 10_000;

export class TreeSitterSymbolIndex implements SymbolIndex {
  private readonly listFiles: (root: string) => Promise<string[]>;
  private readonly parser: ParserProcess;
  private readonly maxResidentRoots: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly notify: Notify;

  private readonly indexes = new Map<string, RootIndex>();
  private readonly building = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private clock = 0;

  constructor(deps: TreeSitterSymbolIndexDeps = {}) {
    this.listFiles = deps.listFiles ?? listCandidateFiles;
    this.maxResidentRoots = deps.maxResidentRoots ?? 6;
    this.maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxFiles = deps.maxFiles ?? 20000;
    this.notify = deps.notify ?? (() => {});
    this.parser = new ParserProcess(deps.parserScript ?? fileURLToPath(new URL("./symbolParser.ts", import.meta.url)), this.notify);
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
    if (!indexable(root, path)) return [];
    const idx = emptyIndex();
    await addReply(idx, await this.parse([path]));
    return withLineText((idx.byFile.get(path) ?? []).filter((o) => o.role === "definition"));
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
      // Cleared up front: a markDirty while this build runs leaves its result stale.
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
    // Only source files wake the parser; any other change just leaves the index.
    const sources = changedPaths.filter((p) => indexable(root, p));
    const reply = sources.length ? await this.parse(sources) : null;
    for (const abs of changedPaths) this.removeFile(idx, abs);
    if (reply) await addReply(idx, reply);
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

  private parse(paths: string[]): Promise<ParseReply> {
    return this.parser.parse({ paths, maxFiles: this.maxFiles, maxFileBytes: this.maxFileBytes });
  }

  private async build(root: string): Promise<RootIndex> {
    const paths = (await this.listFiles(root)).map((rel) => join(root, rel)).filter((p) => indexable(root, p));
    const reply = await this.parse(paths);
    if (reply.capped > 0) this.notify("symbol index file cap hit — some files skipped", { root, cap: this.maxFiles, skipped: reply.capped });
    const idx = emptyIndex();
    await addReply(idx, reply);
    idx.lastUsed = ++this.clock;
    return idx;
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

// The forked symbol parser. Requests are answered in order; IDLE_MS after the
// last answer the process is stopped, which hands tree-sitter's WASM memory
// back to the OS. Its channel holds the event loop open only while a request
// is out.
class ParserProcess {
  private readonly script: string;
  private readonly notify: Notify;
  private readonly waiting = new Map<number, { resolve: (r: ParseReply) => void; reject: (e: Error) => void }>();
  private child: ChildProcess | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  constructor(script: string, notify: Notify) {
    this.script = script;
    this.notify = notify;
  }

  parse(req: Omit<ParseRequest, "id">): Promise<ParseReply> {
    clearTimeout(this.idle);
    const child = this.child ?? this.spawn();
    child.channel?.ref();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      child.send({ ...req, id });
    });
  }

  private spawn(): ChildProcess {
    const child = fork(this.script, { serialization: "advanced" });
    this.child = child;
    child.unref();
    child.on("message", (reply: ParseReply) => {
      for (const n of reply.notes) this.notify(n.msg, n.meta);
      this.waiting.get(reply.id)?.resolve(reply);
      this.waiting.delete(reply.id);
      if (this.waiting.size) return;
      child.channel?.unref();
      this.idle = setTimeout(() => this.stop(child), IDLE_MS);
      this.idle.unref();
    });
    child.on("exit", (code, signal) => this.fail(child, `exited (${signal ?? code})`));
    child.on("error", (e) => {
      this.fail(child, errMsg(e));
      child.kill();
    });
    return child;
  }

  private stop(child: ChildProcess): void {
    if (this.child === child) this.child = null;
    child.kill();
  }

  private fail(child: ChildProcess, reason: string): void {
    if (this.child !== child) return; // stopped on purpose
    this.child = null;
    this.notify("symbol parser process failed — symbol index unavailable", { reason, pending: this.waiting.size });
    const err = new Error(`symbol index unavailable: parser ${reason}`);
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }
}

function emptyIndex(): RootIndex {
  return { byName: new Map(), byFile: new Map(), lastUsed: 0 };
}

// Adds a reply's occurrences (file then capture order), one file at a time,
// yielding every SLICE_MS.
async function addReply(idx: RootIndex, r: ParseReply): Promise<void> {
  const { occ } = r;
  let since = performance.now();
  let file: SymbolOccurrence[] = [];
  for (let i = 0; i < occ.length; i += 6) {
    if (occ[i] !== occ[i - 6]) {
      if (performance.now() - since >= SLICE_MS) {
        await new Promise((res) => setImmediate(res));
        since = performance.now();
      }
      file = [];
      idx.byFile.set(r.paths[occ[i]], file);
    }
    const o: SymbolOccurrence = {
      name: r.names[occ[i + 1]],
      kind: r.kinds[occ[i + 2]],
      role: occ[i + 3] ? "definition" : "reference",
      path: r.paths[occ[i]],
      line: occ[i + 4],
      column: occ[i + 5],
    };
    file.push(o);
    const byName = idx.byName.get(o.name);
    if (byName) byName.push(o);
    else idx.byName.set(o.name, [o]);
  }
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

// Symbol-name ranking, mirroring fs-shared.ts scoreMatch so symbol search ranks
// like filename search: exact > prefix > substring.
function scoreName(name: string, query: string): number {
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  return 0;
}
