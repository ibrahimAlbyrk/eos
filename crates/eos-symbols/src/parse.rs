//! Reading one file into its occurrences.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, QueryCursor};

use crate::languages::{Capture, Grammar, grammar_for};

/// A file larger than this is not parsed.
pub(crate) const MAX_FILE_BYTES: u64 = 512 * 1024;
/// More bytes per line than this is minified or generated code, not written
/// code (which averages well under 100).
const MINIFIED_BYTES_PER_LINE: usize = 300;
/// Bytes looked at to tell a binary file.
const SNIFF_BYTES: usize = 8192;

/// One named thing at one place. Positions are 1-based; the column counts
/// UTF-16 units, as the dashboard's editor does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Occurrence {
    pub(crate) name: Arc<str>,
    pub(crate) kind: Arc<str>,
    pub(crate) definition: bool,
    pub(crate) line: u32,
    pub(crate) column: u32,
}

fn utf16_len(bytes: &[u8]) -> usize {
    String::from_utf8_lossy(bytes).encode_utf16().count()
}

fn occurrences(grammar: &Grammar, source: &[u8]) -> Option<Vec<Occurrence>> {
    let mut parser = Parser::new();
    parser.set_language(&grammar.language).ok()?;
    let tree = parser.parse(source, None)?;
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&grammar.query, tree.root_node(), source);
    let mut found = Vec::new();
    while let Some(matched) = matches.next() {
        let (mut name, mut role) = (None, None);
        for capture in matched.captures {
            match grammar.captures.get(capture.index as usize) {
                Some(Capture::Name) => name = Some(capture.node),
                Some(Capture::Role { definition, kind }) => role = Some((*definition, kind.clone())),
                _ => {}
            }
        }
        let (Some(node), Some((definition, kind))) = (name, role) else { continue };
        let text = String::from_utf8_lossy(&source[node.byte_range()]);
        if text.is_empty() {
            continue;
        }
        let start = node.start_position();
        let line_start = node.start_byte().saturating_sub(start.column);
        found.push(Occurrence {
            name: text.as_ref().into(),
            kind,
            definition,
            line: u32::try_from(start.row + 1).unwrap_or(u32::MAX),
            column: u32::try_from(utf16_len(&source[line_start..node.start_byte()]) + 1).unwrap_or(u32::MAX),
        });
    }
    Some(found)
}

/// The occurrences in a file, in the order the tag query finds them. `None`
/// when the file is not parsed: no grammar, unreadable, binary, too large, or
/// minified.
pub(crate) fn parse_file(path: &Path) -> Option<Vec<Occurrence>> {
    let grammar = grammar_for(path)?;
    if fs::metadata(path).ok()?.len() > MAX_FILE_BYTES {
        return None;
    }
    let source = fs::read(path).ok()?;
    if source[..source.len().min(SNIFF_BYTES)].contains(&0) {
        return None;
    }
    let lines = 1 + source.iter().filter(|b| **b == b'\n').count();
    if source.len() > MINIFIED_BYTES_PER_LINE * lines {
        return None;
    }
    occurrences(grammar, &source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str, source: &str) -> Vec<(String, String, bool, u32, u32)> {
        let grammar = grammar_for(Path::new(name)).expect("a grammar");
        occurrences(grammar, source.as_bytes())
            .expect("parsed")
            .into_iter()
            .map(|o| (o.name.to_string(), o.kind.to_string(), o.definition, o.line, o.column))
            .collect()
    }

    fn row(name: &str, kind: &str, definition: bool, line: u32, column: u32) -> (String, String, bool, u32, u32) {
        (name.to_owned(), kind.to_owned(), definition, line, column)
    }

    // What today's index answers for the wire fixtures' `alpha` project
    // (fixtures/wire/recordings/14-git.json, the symbols steps).
    #[test]
    fn javascript_definitions_and_calls_as_recorded() {
        let parser = "export function parse(text) {\n  if (!text) return [];\n  return text.split(\",\");\n}\n";
        assert!(parse("parser.js", parser).contains(&row("parse", "function", true, 1, 17)));
        let cli = "import { parse } from \"./parser.js\";\n\nconsole.log(parse(process.argv[2] ?? \"\"));\n";
        assert!(parse("cli.js", cli).contains(&row("parse", "call", false, 3, 13)));
    }

    #[test]
    fn each_language_names_its_definitions() {
        let ts = parse(
            "a.ts",
            "export function classifyReport(x: number) { return x }\nexport class Widget { render() { return classifyReport(1) } }\ninterface Shape { area(): number }\n",
        );
        assert!(ts.contains(&row("classifyReport", "function", true, 1, 17)));
        assert!(ts.contains(&row("Widget", "class", true, 2, 14)));
        assert!(ts.contains(&row("render", "method", true, 2, 23)));
        assert!(ts.contains(&row("classifyReport", "call", false, 2, 41)));
        assert!(ts.iter().any(|o| o.0 == "Shape" && o.2), "{ts:?}");

        let py = parse("b.py", "class Foo:\n    def bar(self):\n        classifyReport()\n");
        assert!(py.contains(&row("Foo", "class", true, 1, 7)));
        assert!(py.iter().any(|o| o.0 == "bar" && o.2));
        assert!(py.iter().any(|o| o.0 == "classifyReport" && !o.2));

        assert!(
            parse("c.go", "package p\nfunc Serve() int { return 0 }\n").contains(&row("Serve", "function", true, 2, 6))
        );
        assert!(parse("d.rs", "pub fn run() {}\nstruct Point;\n").iter().any(|o| o.0 == "run" && o.2));
        assert!(parse("E.java", "class Greeter { void hello() {} }\n").iter().any(|o| o.0 == "Greeter" && o.2));
        assert!(parse("f.tsx", "export function App() { return <div/> }\n").iter().any(|o| o.0 == "App" && o.2));
    }

    #[test]
    fn columns_count_utf16_units_not_bytes() {
        // "é" is two bytes and one unit; "😀" is four bytes and two units.
        assert!(parse("a.js", "/* é😀 */ function after() {}\n").contains(&row("after", "function", true, 1, 20)));
        // A byte-order mark is one unit.
        assert!(parse("a.js", "\u{feff}function kept() {}\n").contains(&row("kept", "function", true, 1, 11)));
    }

    #[test]
    fn binary_oversized_and_minified_files_are_not_parsed() {
        let dir = tempfile::tempdir().expect("dir");
        let write = |name: &str, content: &[u8]| {
            let path = dir.path().join(name);
            fs::write(&path, content).expect("write");
            path
        };
        assert!(parse_file(&write("ok.js", b"function ok() {}\n")).is_some_and(|o| o.len() == 1));
        assert_eq!(parse_file(&write("empty.js", b"")), Some(Vec::new()));
        assert_eq!(parse_file(&write("binary.js", b"function a() {}\0\0")), None);
        assert_eq!(
            parse_file(&write("bundle.js", format!("function minified() {{}}{}\n", ";".repeat(1000)).as_bytes())),
            None
        );
        let filler = "let filler = 'abcdefghijklmnopqrstuvwxyz0123456789';\n";
        assert_eq!(
            parse_file(&write("huge.ts", format!("function huge() {{}}\n{}", filler.repeat(10_500)).as_bytes())),
            None
        );
        assert!(
            parse_file(&write("near.ts", format!("function nearCap() {{}}\n{}", filler.repeat(9_500)).as_bytes()))
                .is_some()
        );
        assert_eq!(parse_file(&write("notes.md", b"# hi")), None);
        assert_eq!(parse_file(&dir.path().join("missing.js")), None);
    }
}
