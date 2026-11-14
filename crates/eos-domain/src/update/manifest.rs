//! A manifest arrives signed, yet its shape is checked again before a byte is
//! written: every path stays inside the bundle, a link can neither point out of
//! it nor be walked through, and chunk references are in range and add up.

use std::collections::HashSet;

use eos_contracts::update::{UpdateEntry, UpdateManifest};
use eos_contracts::validate;

use super::chunker::CHUNK_MAX;
use super::error::UpdateError;

/// A manifest path's segments, or `None` when it could land outside its folder.
pub fn rel_segments(rel: &str) -> Option<Vec<&str>> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") { None } else { Some(parts) }
}

/// A link's target, resolved from the folder the link sits in, stays inside the bundle.
pub fn link_stays_inside(link_segments: &[&str], target: &str) -> bool {
    if target.is_empty() || target.starts_with('/') || target.contains('\0') {
        return false;
    }
    let mut depth = link_segments.len().saturating_sub(1);
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => match depth.checked_sub(1) {
                Some(up) => depth = up,
                None => return false,
            },
            _ => depth += 1,
        }
    }
    true
}

/// What is wrong with a manifest's content, if anything.
pub fn manifest_problem(manifest: &UpdateManifest) -> Option<String> {
    let packs = i64::try_from(manifest.packs.len()).unwrap_or(i64::MAX);
    for c in &manifest.chunks {
        if c.pack >= packs {
            return Some(format!("chunk {} names pack {}", c.id, c.pack));
        }
        if c.size > CHUNK_MAX as i64 {
            return Some(format!("chunk {} is larger than any chunk can be", c.id));
        }
    }

    let mut paths = HashSet::new();
    let mut links = HashSet::new();
    for e in &manifest.entries {
        let path = entry_path(e);
        let Some(segments) = rel_segments(path) else {
            // `JSON.stringify(path)`, as today's message quotes it.
            return Some(format!("unsafe path {}", serde_json::Value::String(path.to_owned())));
        };
        if !paths.insert(path) {
            return Some(format!("{path} is listed twice"));
        }
        match e {
            UpdateEntry::Dir(_) => {}
            UpdateEntry::Link(link) => {
                if !link_stays_inside(&segments, &link.target) {
                    return Some(format!("{path} links outside the bundle"));
                }
                links.insert(path);
            }
            UpdateEntry::File(file) => {
                let mut sum = 0i64;
                for i in &file.chunks {
                    let Some(c) = usize::try_from(*i).ok().and_then(|i| manifest.chunks.get(i)) else {
                        return Some(format!("{path} names chunk {i}"));
                    };
                    sum += c.size;
                }
                if sum != file.size {
                    return Some(format!("{path}: its chunks add up to {sum} bytes, not {}", file.size));
                }
                if let Some(whole) = &file.whole
                    && whole.pack >= packs
                {
                    return Some(format!("{path} names pack {}", whole.pack));
                }
            }
        }
    }

    // Writing under a link would write wherever the link points.
    for e in &manifest.entries {
        let path = entry_path(e);
        for (at, _) in path.match_indices('/') {
            let ancestor = &path[..at];
            if links.contains(ancestor) {
                return Some(format!("{path} lies under the link {ancestor}"));
            }
        }
    }
    None
}

pub fn entry_path(entry: &UpdateEntry) -> &str {
    match entry {
        UpdateEntry::Dir(e) => &e.path,
        UpdateEntry::Link(e) => &e.path,
        UpdateEntry::File(e) => &e.path,
    }
}

/// Reads a manifest's JSON and checks it against the schema (format 1; fields
/// this build does not know are ignored). The content rules are
/// [`manifest_problem`]'s.
pub fn parse_manifest(json: &[u8]) -> Result<UpdateManifest, UpdateError> {
    let value: serde_json::Value = serde_json::from_slice(json)
        .map_err(|_| UpdateError::bad_release("the feed sent something that is not JSON"))?;
    validate::parse(&value).map_err(|_| UpdateError::bad_release("the manifest is malformed"))
}

#[cfg(test)]
mod tests {
    use eos_contracts::primitives::IntLit;
    use eos_contracts::update::{
        AppVersion, PackSpan, UpdateChunk, UpdateEntryDir, UpdateEntryFile, UpdateEntryLink, UpdatePlatform,
    };

    use super::*;

    fn hash(n: u64) -> String {
        format!("{n:064x}")
    }

    fn manifest_of(entries: Vec<UpdateEntry>, chunks: Vec<UpdateChunk>) -> UpdateManifest {
        UpdateManifest {
            format: IntLit,
            version: AppVersion("0.1.3".into()),
            platform: UpdatePlatform::DarwinArm64,
            packs: vec!["packs/darwin-arm64/0.1.3.pack".into()],
            chunks,
            entries,
        }
    }

    fn chunks() -> Vec<UpdateChunk> {
        vec![
            UpdateChunk { id: hash(1), size: 10, pack: 0, offset: 0, zsize: 6 },
            UpdateChunk { id: hash(2), size: 5, pack: 0, offset: 6, zsize: 4 },
        ]
    }

    fn file(path: &str, size: i64, ids: &[i64]) -> UpdateEntry {
        UpdateEntry::File(UpdateEntryFile {
            path: path.into(),
            mode: 0o644,
            size,
            sha256: hash(99),
            chunks: ids.to_vec(),
            whole: None,
        })
    }

    fn link(path: &str, target: &str) -> UpdateEntry {
        UpdateEntry::Link(UpdateEntryLink { path: path.into(), target: target.into() })
    }

    fn problem(entries: Vec<UpdateEntry>, chunks: Vec<UpdateChunk>) -> String {
        manifest_problem(&manifest_of(entries, chunks)).unwrap_or_default()
    }

    #[test]
    fn a_well_formed_bundle_passes() {
        let m = manifest_of(
            vec![
                UpdateEntry::Dir(UpdateEntryDir { path: "Contents".into(), mode: 0o755 }),
                file("Contents/Info.plist", 15, &[0, 1]),
                link("Contents/Frameworks/E.framework/Versions/Current", "A"),
                link("Contents/Frameworks/E.framework/Resources", "Versions/Current/Resources"),
            ],
            chunks(),
        );
        assert_eq!(manifest_problem(&m), None);
    }

    #[test]
    fn paths_and_links_that_leave_the_bundle_are_refused() {
        assert_eq!(problem(vec![file("../evil", 15, &[0, 1])], chunks()), "unsafe path \"../evil\"");
        assert!(problem(vec![link("Contents/l", "../../etc")], vec![]).contains("outside"));
        assert!(problem(vec![link("Contents/l", "/etc")], vec![]).contains("outside"));
    }

    #[test]
    fn writing_through_a_link_is_refused() {
        let found = problem(vec![link("Contents/l", "A"), file("Contents/l/f", 15, &[0, 1])], chunks());
        assert_eq!(found, "Contents/l/f lies under the link Contents/l");
    }

    #[test]
    fn chunk_references_must_add_up() {
        assert!(problem(vec![file("a", 16, &[0, 1])], chunks()).contains("add up to 15 bytes, not 16"));
        assert!(problem(vec![file("a", 15, &[0, 5])], chunks()).contains("names chunk 5"));
        assert!(problem(vec![file("a", 15, &[0, 1]), file("a", 15, &[0, 1])], chunks()).contains("listed twice"));
        let mut far = chunks();
        far[0].pack = 3;
        assert!(problem(vec![], far).contains("names pack 3"));
        let mut whole = file("a", 15, &[0, 1]);
        if let UpdateEntry::File(f) = &mut whole {
            f.whole = Some(PackSpan { pack: 2, offset: 0, zsize: 1 });
        }
        assert_eq!(problem(vec![whole], chunks()), "a names pack 2");
    }

    #[test]
    fn a_link_resolves_from_the_folder_it_sits_in() {
        assert!(link_stays_inside(&["a", "b"], ".."));
        assert!(!link_stays_inside(&["a"], ".."));
        assert!(link_stays_inside(&["a", "b"], "./c/../d"));
    }

    #[test]
    fn a_manifest_of_another_format_is_malformed() {
        let json = br#"{"format":2,"version":"1.0.0","platform":"darwin-arm64","packs":[],"chunks":[],"entries":[]}"#;
        assert_eq!(parse_manifest(json).expect_err("format 2").message, "the manifest is malformed");
        let json = br#"{"format":1,"version":"1.0.0","platform":"darwin-arm64","packs":[],"chunks":[],"entries":[],"later":true}"#;
        assert!(parse_manifest(json).is_ok(), "fields this build does not know are ignored");
        assert_eq!(parse_manifest(b"<html>").expect_err("html").message, "the feed sent something that is not JSON");
    }
}
