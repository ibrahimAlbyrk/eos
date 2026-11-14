//! Which files are parsed, and with what.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use tree_sitter::{Language, Query};

/// What a capture of a tag query says about its match.
#[derive(Debug, Clone)]
pub(crate) enum Capture {
    /// `@name`: the symbol's name and position.
    Name,
    /// `@definition.<kind>` or `@reference.<kind>`.
    Role {
        definition: bool,
        kind: Arc<str>,
    },
    Other,
}

#[derive(Debug)]
pub(crate) struct Grammar {
    pub(crate) language: Language,
    pub(crate) query: Query,
    /// By capture index.
    pub(crate) captures: Vec<Capture>,
}

const JAVASCRIPT: &str = include_str!("../queries/javascript.scm");
const TYPESCRIPT: &str = include_str!("../queries/typescript.scm");

/// File extensions (lower case, without the dot) of the languages that take part.
const EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "pyi", "go", "rs", "java"];

/// Folder names where projects keep code they ship but did not write.
const VENDOR_DIRS: &[&str] =
    &["vendor", "vendors", "vendored", "third_party", "third-party", "thirdparty", "node_modules", "bower_components"];

fn build(id: &'static str, language: Language, query: &str) -> Option<Grammar> {
    match Query::new(&language, query) {
        Ok(query) => {
            let captures = query
                .capture_names()
                .iter()
                .map(|name| {
                    if *name == "name" {
                        Capture::Name
                    } else if let Some(kind) = name.strip_prefix("definition.") {
                        Capture::Role { definition: true, kind: kind.into() }
                    } else if let Some(kind) = name.strip_prefix("reference.") {
                        Capture::Role { definition: false, kind: kind.into() }
                    } else {
                        Capture::Other
                    }
                })
                .collect();
            Some(Grammar { language, query, captures })
        }
        // A grammar whose query does not compile switches that language off;
        // the others keep working.
        Err(error) => {
            tracing::warn!(grammar = id, %error, "symbol grammar unavailable");
            None
        }
    }
}

struct Grammars {
    javascript: Option<Grammar>,
    typescript: Option<Grammar>,
    tsx: Option<Grammar>,
    python: Option<Grammar>,
    go: Option<Grammar>,
    rust: Option<Grammar>,
    java: Option<Grammar>,
}

fn grammars() -> &'static Grammars {
    static GRAMMARS: OnceLock<Grammars> = OnceLock::new();
    GRAMMARS.get_or_init(|| {
        let typescript_query = format!("{JAVASCRIPT}\n{TYPESCRIPT}");
        Grammars {
            javascript: build("javascript", tree_sitter_javascript::LANGUAGE.into(), JAVASCRIPT),
            typescript: build("typescript", tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), &typescript_query),
            tsx: build("tsx", tree_sitter_typescript::LANGUAGE_TSX.into(), &typescript_query),
            python: build("python", tree_sitter_python::LANGUAGE.into(), include_str!("../queries/python.scm")),
            go: build("go", tree_sitter_go::LANGUAGE.into(), include_str!("../queries/go.scm")),
            rust: build("rust", tree_sitter_rust::LANGUAGE.into(), include_str!("../queries/rust.scm")),
            java: build("java", tree_sitter_java::LANGUAGE.into(), include_str!("../queries/java.scm")),
        }
    })
}

fn extension(path: &Path) -> Option<String> {
    path.extension().and_then(|ext| ext.to_str()).map(str::to_lowercase)
}

/// The grammar for a file, by its extension; `None` when its language does
/// not take part or its grammar did not load.
pub(crate) fn grammar_for(path: &Path) -> Option<&'static Grammar> {
    let all = grammars();
    match extension(path)?.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => all.javascript.as_ref(),
        "ts" | "mts" | "cts" => all.typescript.as_ref(),
        "tsx" => all.tsx.as_ref(),
        "py" | "pyi" => all.python.as_ref(),
        "go" => all.go.as_ref(),
        "rs" => all.rust.as_ref(),
        "java" => all.java.as_ref(),
        _ => None,
    }
}

/// `name.min.<ext>`.
fn is_minified_name(file: &str) -> bool {
    let Some((stem, ext)) = file.rsplit_once('.') else { return false };
    !ext.is_empty() && stem.len() >= 4 && stem[stem.len() - 4..].eq_ignore_ascii_case(".min")
}

/// A file of a participating language that the project wrote: not under a
/// vendor folder below the root, not minified by name. Its content is judged
/// when it is read.
pub(crate) fn indexable(root: &Path, path: &Path) -> bool {
    if !extension(path).is_some_and(|ext| EXTENSIONS.contains(&ext.as_str())) {
        return false;
    }
    let below = path.strip_prefix(root).unwrap_or(path);
    let mut segments: Vec<String> = below.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let file = segments.pop().unwrap_or_default();
    !is_minified_name(&file) && !segments.iter().any(|dir| VENDOR_DIRS.contains(&dir.to_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_grammar_loads_with_its_query() {
        for file in ["a.js", "a.mjs", "a.jsx", "a.ts", "a.cts", "a.tsx", "a.py", "a.pyi", "a.go", "a.rs", "A.JAVA"] {
            assert!(grammar_for(Path::new(file)).is_some(), "{file}");
        }
        assert!(grammar_for(Path::new("README.md")).is_none());
        assert!(grammar_for(Path::new("Makefile")).is_none());
    }

    #[test]
    fn vendored_and_minified_files_are_not_indexable() {
        let root = Path::new("/p");
        for yes in ["/p/a.ts", "/p/src/b.py", "/p/vendorish/own.ts", "/p/x.min/a.js", "/p/admin.js"] {
            assert!(indexable(root, Path::new(yes)), "{yes}");
        }
        for no in [
            "/p/README.md",
            "/p/vendor/dep.ts",
            "/p/Third_Party/dep.ts",
            "/p/a/node_modules/x/i.js",
            "/p/lib/x.min.js",
            "/p/lib/X.MIN.JS",
        ] {
            assert!(!indexable(root, Path::new(no)), "{no}");
        }
        // Only folders below the root count: a project that itself lives under `vendor/`.
        assert!(indexable(Path::new("/code/vendor/app"), Path::new("/code/vendor/app/src/a.ts")));
    }
}
