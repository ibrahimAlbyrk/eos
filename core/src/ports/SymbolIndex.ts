// SymbolIndex port — syntactic symbol intelligence for the Files explorer
// (go-to-definition, find-references, symbol-name search). Pure: only TS types
// + Promise, zero node imports. The adapter (TreeSitterSymbolIndex, infra) does
// the parsing; core stays ignorant of tree-sitter.
//
// This tier is name-matched, not binding-resolved: same-named symbols across
// files produce false positives (the honest MVP limit). A future semantic
// adapter returns the SAME flat SymbolOccurrence shape behind this port, so
// consumers never change (Open/closed, Liskov).

export type SymbolRole = "definition" | "reference";

// A syntactic occurrence of a named entity. Deliberately flat — a route can
// serialize it directly; a future semantic adapter returns the same shape.
export interface SymbolOccurrence {
  name: string; // bare identifier, e.g. "classifyReport"
  kind: string; // tree-sitter tag kind: "function" | "class" | "method" | ...
  role: SymbolRole; // from the tag's @definition.* / @reference.* capture
  path: string; // absolute file path
  line: number; // 1-based
  column: number; // 1-based
  lineText?: string; // the source line, for the refs/search list rows
}

// ISP: read surface. Route handlers depend only on this.
export interface SymbolQuery {
  definitions(root: string, name: string, fromPath?: string): Promise<SymbolOccurrence[]>;
  references(root: string, name: string): Promise<SymbolOccurrence[]>;
  searchSymbols(root: string, query: string, limit: number): Promise<SymbolOccurrence[]>;
  // Every definition occurrence in a single file (one parse) — no symbol name
  // needed. The CodeLens surface: enumerate the open file's functions/classes/etc.
  // `path` is absolute.
  definitionsInFile(root: string, path: string): Promise<SymbolOccurrence[]>;
}

// ISP: lifecycle surface. Container/wiring depends on this; routes do not.
export interface SymbolIndexLifecycle {
  ensureIndexed(root: string): Promise<void>; // idempotent, keyed by root
  invalidate(root: string, changedPaths: string[]): Promise<void>;
  release(root: string): void; // worktree gone → drop its index
}

export interface SymbolIndex extends SymbolQuery, SymbolIndexLifecycle {}
