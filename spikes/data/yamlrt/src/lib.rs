//! Spike 8: YAML and frontmatter files as today's code reads and writes them
//! (`yaml` 2.9.0 for npm: YAML 1.2 core schema; one frontmatter regex shared by
//! every reader).

pub mod libs;

/// `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/` — the frontmatter fence every reader
/// uses. Returns the YAML between the fences and the body after them.
///
/// Its corners, kept on purpose: the closing fence is the first `\n---`, even
/// when more follows on that line; `---\n---` (nothing between) is not
/// frontmatter; a byte-order mark before the first fence means no frontmatter.
pub fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let after_open = raw.strip_prefix("---\r\n").or_else(|| raw.strip_prefix("---\n"))?;
    let close = after_open.find("\n---")?;
    // A CR before the closing line feed belongs to the fence, not the YAML.
    let yaml = after_open[..close].strip_suffix('\r').unwrap_or(&after_open[..close]);
    let mut body = &after_open[close + "\n---".len()..];
    body = body.strip_prefix('\r').unwrap_or(body);
    body = body.strip_prefix('\n').unwrap_or(body);
    Some((yaml, body))
}

#[cfg(test)]
mod tests {
    use super::split_frontmatter;

    #[test]
    fn the_fence_corners() {
        assert_eq!(split_frontmatter("---\na: 1\n---\nbody\n"), Some(("a: 1", "body\n")));
        assert_eq!(split_frontmatter("---\r\na: 1\r\n---\r\nbody"), Some(("a: 1", "body")));
        assert_eq!(split_frontmatter("---\na: 1\n---"), Some(("a: 1", "")));
        assert_eq!(split_frontmatter("---\na: 1\n----\nrest"), Some(("a: 1", "-\nrest")));
        assert_eq!(split_frontmatter("---\n---\nbody\n"), None);
        assert_eq!(split_frontmatter("---\n\n---\nbody\n"), Some(("", "body\n")));
        assert_eq!(split_frontmatter("\u{feff}---\na: 1\n---\n"), None);
        assert_eq!(split_frontmatter("# no fence\n---\n"), None);
    }
}
