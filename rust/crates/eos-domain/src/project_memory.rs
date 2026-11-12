//! Claude Code's file memory of a project (`core/src/domain/memory-index.ts`):
//! one markdown file per memory, and `MEMORY.md`, the index Claude loads,
//! one line per memory (`- [Title](slug.md) — hook`).

/// The index without the lines that link to `<name>.md`. The link is matched,
/// not the title, so however a line was worded it goes; every other line stays
/// exactly as a person or Claude wrote it.
pub fn remove_from_index(index: &str, name: &str) -> String {
    let link = format!("]({name}.md)");
    index.split('\n').filter(|line| !line.contains(&link)).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/memory-index.test.ts
    #[test]
    fn only_the_lines_linking_to_the_memory_go() {
        let index =
            "# Memory\n- [Tabs](tabs_in_go.md) — gofmt\n- [Other](other.md) — keep\n- see [Tabs](tabs_in_go.md) too\n";
        assert_eq!(remove_from_index(index, "tabs_in_go"), "# Memory\n- [Other](other.md) — keep\n");
        assert_eq!(remove_from_index("", "x"), "");
        assert_eq!(remove_from_index("- [A](a.md)", "a"), "");
    }
}
