// What the symbol index parses — shared by TreeSitterSymbolIndex (which files
// to send) and the symbol parser process (which grammars to load).

import { extname, relative } from "node:path";

// Priority set (dim03 §4): TS/JS, Python, Go, Rust, Java. TS/TSX inherit the JS
// tags (the upstream TS tags.scm is the TS-only delta), so their `scm` composes
// javascript + typescript. wasm names match @vscode/tree-sitter-wasm/wasm/.
export interface GrammarDef {
  id: string;
  wasm: string;
  scm: string[];
  exts: string[];
}

export const GRAMMARS: GrammarDef[] = [
  { id: "javascript", wasm: "tree-sitter-javascript.wasm", scm: ["javascript"], exts: [".js", ".mjs", ".cjs", ".jsx"] },
  { id: "typescript", wasm: "tree-sitter-typescript.wasm", scm: ["javascript", "typescript"], exts: [".ts", ".mts", ".cts"] },
  { id: "tsx", wasm: "tree-sitter-tsx.wasm", scm: ["javascript", "typescript"], exts: [".tsx"] },
  { id: "python", wasm: "tree-sitter-python.wasm", scm: ["python"], exts: [".py", ".pyi"] },
  { id: "go", wasm: "tree-sitter-go.wasm", scm: ["go"], exts: [".go"] },
  { id: "rust", wasm: "tree-sitter-rust.wasm", scm: ["rust"], exts: [".rs"] },
  { id: "java", wasm: "tree-sitter-java.wasm", scm: ["java"], exts: [".java"] },
];

const EXTS = new Set(GRAMMARS.flatMap((g) => g.exts));
// Conventional homes of code a project ships but doesn't write.
const VENDOR_DIRS = new Set(["vendor", "vendors", "vendored", "third_party", "third-party", "thirdparty", "node_modules", "bower_components"]);

// A participating language outside vendored code (a vendor-dir segment under
// the root, or a minified name). The parser checks content when it reads it.
export function indexable(root: string, abs: string): boolean {
  if (!EXTS.has(extname(abs).toLowerCase())) return false;
  const dirs = relative(root, abs).split(/[\\/]/);
  const file = dirs.pop() ?? "";
  return !/\.min\.[^.]+$/i.test(file) && !dirs.some((d) => VENDOR_DIRS.has(d.toLowerCase()));
}
