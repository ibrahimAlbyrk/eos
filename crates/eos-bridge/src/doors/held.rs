//! What a door outside Eos hands the quick panel (07 §4.3): the selection under the shortcut,
//! a Services request, a share, a Dock drop or an `eos://send` link. It is held in memory until
//! the panel closes and is never logged: only its source, kinds and counts.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Value, json};

/// The most parts one item holds.
pub const MAX_PARTS: usize = 20;
/// The longest text part, in bytes.
pub const MAX_TEXT: usize = 64 * 1024;

/// Which door the item came through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorSource {
    Shortcut,
    Services,
    Share,
    Dock,
    Link,
}

impl DoorSource {
    pub fn name(self) -> &'static str {
        match self {
            DoorSource::Shortcut => "shortcut",
            DoorSource::Services => "services",
            DoorSource::Share => "share",
            DoorSource::Dock => "dock",
            DoorSource::Link => "link",
        }
    }
}

/// One thing the door carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoorPart {
    Text(String),
    Url(String),
    File(PathBuf),
    Folder(PathBuf),
}

impl DoorPart {
    /// A path the system handed over, as a file or a folder by what is there now.
    pub fn of_path(path: PathBuf) -> Self {
        if path.is_dir() { DoorPart::Folder(path) } else { DoorPart::File(path) }
    }

    fn kind(&self) -> &'static str {
        match self {
            DoorPart::Text(_) => "text",
            DoorPart::Url(_) => "url",
            DoorPart::File(_) => "file",
            DoorPart::Folder(_) => "folder",
        }
    }

    fn to_json(&self) -> Value {
        match self {
            DoorPart::Text(text) => json!({ "kind": "text", "text": text }),
            DoorPart::Url(url) => json!({ "kind": "url", "url": url }),
            DoorPart::File(path) | DoorPart::Folder(path) => {
                json!({ "kind": self.kind(), "path": path.to_string_lossy() })
            }
        }
    }
}

/// The item a door holds for the panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoorItem {
    pub source: DoorSource,
    /// The app it came from, when the door knows (the shortcut's front app).
    pub app: Option<String>,
    pub parts: Vec<DoorPart>,
}

impl DoorItem {
    /// The item within its limits: empty parts dropped, text cut at [`MAX_TEXT`] on a character
    /// boundary, at most [`MAX_PARTS`] parts.
    pub fn new(source: DoorSource, app: Option<String>, parts: Vec<DoorPart>) -> Self {
        let parts = parts
            .into_iter()
            .filter_map(|part| match part {
                DoorPart::Text(text) if text.trim().is_empty() => None,
                DoorPart::Text(text) => Some(DoorPart::Text(cut(text))),
                DoorPart::Url(url) if url.is_empty() || url.len() > MAX_TEXT => None,
                DoorPart::File(path) | DoorPart::Folder(path) if path.as_os_str().is_empty() => None,
                part => Some(part),
            })
            .take(MAX_PARTS)
            .collect();
        DoorItem { source, app: app.filter(|a| !a.is_empty()), parts }
    }

    /// What the panel's page reads (`GET /_shell/doors/held`, the `doors:held` event).
    pub fn to_json(&self) -> Value {
        json!({
            "source": self.source.name(),
            "app": self.app,
            "parts": self.parts.iter().map(DoorPart::to_json).collect::<Vec<_>>(),
        })
    }

    /// For the log: the source, and the kinds with their counts. Never the content.
    pub fn describe(&self) -> String {
        let mut kinds: Vec<(&str, usize)> = Vec::new();
        for part in &self.parts {
            match kinds.iter_mut().find(|(kind, _)| *kind == part.kind()) {
                Some((_, n)) => *n += 1,
                None => kinds.push((part.kind(), 1)),
            }
        }
        let kinds: Vec<String> = kinds.iter().map(|(kind, n)| format!("{n} {kind}")).collect();
        let kinds = if kinds.is_empty() { "nothing".to_string() } else { kinds.join(", ") };
        format!("{} item: {kinds}", self.source.name())
    }
}

fn cut(mut text: String) -> String {
    if text.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// The one item held for the panel: a newer door replaces it, closing the panel drops it.
#[derive(Debug, Default)]
pub struct Held(Mutex<Option<DoorItem>>);

impl Held {
    pub fn hold(&self, item: DoorItem) {
        *self.lock() = Some(item);
    }

    /// The held item as the page reads it, `null` when there is none.
    pub fn read(&self) -> Value {
        self.lock().as_ref().map_or(Value::Null, DoorItem::to_json)
    }

    pub fn drop_item(&self) {
        self.lock().take();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<DoorItem>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_keeps_to_its_limits() {
        let long = "é".repeat(MAX_TEXT);
        let mut parts = vec![DoorPart::Text("  ".into()), DoorPart::Text(long), DoorPart::Url(String::new())];
        parts.extend((0..30).map(|i| DoorPart::File(PathBuf::from(format!("/tmp/f{i}")))));
        let item = DoorItem::new(DoorSource::Services, Some(String::new()), parts);
        assert_eq!(item.parts.len(), MAX_PARTS);
        let DoorPart::Text(text) = &item.parts[0] else { panic!("text first") };
        assert!(text.len() <= MAX_TEXT && text.len() > MAX_TEXT - 2, "cut on a character boundary");
        assert_eq!(item.app, None);
    }

    #[test]
    fn the_page_reads_kinds_and_the_log_reads_only_counts() {
        let item = DoorItem::new(
            DoorSource::Shortcut,
            Some("Safari".into()),
            vec![
                DoorPart::Text("secret words".into()),
                DoorPart::Url("https://example.com/private".into()),
                DoorPart::File("/Users/x/a.pdf".into()),
                DoorPart::File("/Users/x/b.pdf".into()),
            ],
        );
        assert_eq!(
            item.to_json(),
            json!({ "source": "shortcut", "app": "Safari", "parts": [
                { "kind": "text", "text": "secret words" },
                { "kind": "url", "url": "https://example.com/private" },
                { "kind": "file", "path": "/Users/x/a.pdf" },
                { "kind": "file", "path": "/Users/x/b.pdf" },
            ]})
        );
        let line = item.describe();
        assert_eq!(line, "shortcut item: 1 text, 1 url, 2 file");
        assert!(!line.contains("secret") && !line.contains("Safari") && !line.contains("a.pdf"));
    }

    #[test]
    fn a_path_is_a_folder_or_a_file_by_what_is_there() {
        assert_eq!(DoorPart::of_path(std::env::temp_dir()), DoorPart::Folder(std::env::temp_dir()));
        assert!(matches!(DoorPart::of_path("/no/such/file".into()), DoorPart::File(_)));
    }

    #[test]
    fn the_held_item_is_replaced_and_dropped() {
        let held = Held::default();
        assert_eq!(held.read(), Value::Null);
        held.hold(DoorItem::new(DoorSource::Link, None, vec![DoorPart::Text("a".into())]));
        held.hold(DoorItem::new(DoorSource::Dock, None, vec![DoorPart::Folder("/tmp".into())]));
        assert_eq!(held.read()["source"], "dock");
        held.drop_item();
        assert_eq!(held.read(), Value::Null);
    }
}
