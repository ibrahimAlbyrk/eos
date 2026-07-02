# Vendored tree-sitter `tags.scm` queries

These are the syntactic tag queries that drive the symbol index
(`TreeSitterSymbolIndex`). A language participates iff both its grammar WASM
(shipped by `@vscode/tree-sitter-wasm`) and its `tags.scm` here are present —
coverage is data, not code.

Each file is the upstream grammar's `queries/tags.scm`, copied verbatim (MIT),
pinned to the grammar version the bundled WASM was built from:

| file             | source npm package         | version | matches `@vscode/tree-sitter-wasm` |
|------------------|----------------------------|---------|------------------------------------|
| `javascript.scm` | `tree-sitter-javascript`   | 0.25.0  | `tree-sitter-javascript.wasm`      |
| `typescript.scm` | `tree-sitter-typescript`   | 0.23.2  | `tree-sitter-typescript/tsx.wasm`  |
| `python.scm`     | `tree-sitter-python`       | 0.25.0  | `tree-sitter-python.wasm`          |
| `go.scm`         | `tree-sitter-go`           | 0.25.0  | `tree-sitter-go.wasm`              |
| `rust.scm`       | `tree-sitter-rust`         | 0.24.0  | `tree-sitter-rust.wasm`            |
| `java.scm`       | `tree-sitter-java`         | 0.23.5  | `tree-sitter-java.wasm`            |

TypeScript/TSX inherit JavaScript: the adapter compiles `javascript.scm`
concatenated with `typescript.scm` against the TS/TSX grammar (the upstream TS
`tags.scm` is the TS-only delta on top of the JS base).

All source grammars are MIT-licensed. tree-sitter itself is MIT. No GPL code is
vendored (universal-ctags is rejected by design).
