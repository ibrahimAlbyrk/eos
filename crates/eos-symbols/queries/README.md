# Tag queries

The tree-sitter queries that find definitions and references. A language
takes part when its grammar crate is a dependency and its query is here.

Each file is the upstream grammar's `queries/tags.scm`, copied verbatim (MIT),
for the grammar version pinned in `Cargo.toml`:

| File | Grammar crate | Version |
|---|---|---|
| `javascript.scm` | `tree-sitter-javascript` | 0.25.0 |
| `typescript.scm` | `tree-sitter-typescript` (TypeScript and TSX) | 0.23.2 |
| `python.scm` | `tree-sitter-python` | 0.25.0 |
| `go.scm` | `tree-sitter-go` | 0.25.0 |
| `rust.scm` | `tree-sitter-rust` | 0.24.0 |
| `java.scm` | `tree-sitter-java` | 0.23.5 |

TypeScript and TSX use `javascript.scm` followed by `typescript.scm`: the
upstream TypeScript query holds only what TypeScript adds to JavaScript.
