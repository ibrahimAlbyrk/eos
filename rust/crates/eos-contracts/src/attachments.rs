//! Port of `contracts/src/attachments.ts`.
//!
//! Attachments are stored as a suffix inside each user-message text:
//!
//! ```text
//! \n\nattachments:\n- [label] (image|file|folder): /abs/path
//! ```
//!
//! The dashboard writes and re-reads the same format (`lib/attachmentTokens.js`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::{Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub kind: AttachmentKind,
    pub path: String,
    pub message_id: Num,
    pub ts: Num,
}

impl Validate for ChatAttachment {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    File,
    Folder,
}

impl Validate for AttachmentKind {}

/// One attachment line, before the row it came from is known. `label` is
/// absent for the legacy bare `image:` / `file:` / `folder:` forms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttachment {
    pub label: Option<String>,
    pub kind: AttachmentKind,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttachmentMessage {
    pub display: String,
    pub attachments: Vec<ParsedAttachment>,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
            Self::Folder => "folder",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "image" => Some(Self::Image),
            "file" => Some(Self::File),
            "folder" => Some(Self::Folder),
            _ => None,
        }
    }
}

const MARKER: &str = "\n\nattachments:\n";

pub fn kind_from_ext(path: &str) -> AttachmentKind {
    let ext = path.rsplit('.').next().unwrap_or(path).to_lowercase();
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg") {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    }
}

/// The suffix for `(label, path, kind)` entries; entries with an empty path
/// are left out. The `(kind)` note lets the reader tell a folder from a file.
pub fn build_attachment_suffix(entries: &[(&str, &str, Option<AttachmentKind>)]) -> String {
    let lines: Vec<String> = entries
        .iter()
        .filter(|(_, path, _)| !path.is_empty())
        .map(|(label, path, kind)| match kind {
            Some(kind) => format!("- {label} ({}): {path}", kind.as_str()),
            None => format!("- {label}: {path}"),
        })
        .collect();
    if lines.is_empty() { String::new() } else { format!("{MARKER}{}", lines.join("\n")) }
}

/// Splits the `attachments:` suffix off a sent message. Reads the legacy
/// `{image #1}` and bare `image:` forms too, and infers the kind from the
/// extension when the `(kind)` note is absent.
pub fn parse_attachment_message(text: &str) -> ParsedAttachmentMessage {
    let Some(idx) = text.find(MARKER) else {
        return ParsedAttachmentMessage { display: text.to_owned(), attachments: Vec::new() };
    };
    let attachments = text[idx + MARKER.len()..]
        .split('\n')
        .map(|line| crate::primitives::de::js_trim(line.strip_prefix("- ").unwrap_or(line)))
        .filter(|line| !line.is_empty())
        .map(parse_line)
        .collect();
    ParsedAttachmentMessage { display: text[..idx].to_owned(), attachments }
}

fn parse_line(raw: &str) -> ParsedAttachment {
    let group = |m: &regress::Match, i: usize| m.group(i).map(|r| raw[r].to_owned());
    if let Some(m) = re!(r"^(\[[^\]]+\])(?:\s+\((image|file|folder)\))?:\s*(.+)$").find(raw) {
        let path = group(&m, 3).unwrap_or_default();
        let kind = group(&m, 2).and_then(|k| AttachmentKind::from_name(&k)).unwrap_or_else(|| kind_from_ext(&path));
        return ParsedAttachment { label: group(&m, 1), kind, path };
    }
    if let Some(m) = re!(r"^(\{(image|file|folder) #\d+\}):\s*(.+)$").find(raw) {
        let kind = group(&m, 2).and_then(|k| AttachmentKind::from_name(&k)).unwrap_or(AttachmentKind::File);
        return ParsedAttachment { label: group(&m, 1), kind, path: group(&m, 3).unwrap_or_default() };
    }
    if let Some(m) = re!(r"^(folder|file|image):\s*(.+)$").find(raw) {
        let kind = group(&m, 1).and_then(|k| AttachmentKind::from_name(&k)).unwrap_or(AttachmentKind::File);
        return ParsedAttachment { label: None, kind, path: group(&m, 2).unwrap_or_default() };
    }
    ParsedAttachment { label: None, kind: kind_from_ext(raw), path: raw.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(label: Option<&str>, kind: AttachmentKind, path: &str) -> ParsedAttachment {
        ParsedAttachment { label: label.map(str::to_owned), kind, path: path.to_owned() }
    }

    // contracts/src/__tests__/attachments.test.ts
    #[test]
    fn kind_from_the_extension() {
        assert_eq!(kind_from_ext("/a/b.png"), AttachmentKind::Image);
        assert_eq!(kind_from_ext("/a/B.JPG"), AttachmentKind::Image);
        assert_eq!(kind_from_ext("/a/notes.txt"), AttachmentKind::File);
        assert_eq!(kind_from_ext("/a/no-ext"), AttachmentKind::File);
    }

    #[test]
    fn no_suffix_is_all_display() {
        assert_eq!(
            parse_attachment_message("just text"),
            ParsedAttachmentMessage { display: "just text".into(), attachments: vec![] }
        );
        assert_eq!(
            parse_attachment_message(""),
            ParsedAttachmentMessage { display: String::new(), attachments: vec![] }
        );
    }

    #[test]
    fn reads_every_line_form() {
        let text = "look at these\n\nattachments:\n- [a.png] (image): /abs/a.png\n- [docs] (folder): /abs/docs";
        let parsed = parse_attachment_message(text);
        assert_eq!(parsed.display, "look at these");
        assert_eq!(
            parsed.attachments,
            [
                att(Some("[a.png]"), AttachmentKind::Image, "/abs/a.png"),
                att(Some("[docs]"), AttachmentKind::Folder, "/abs/docs")
            ]
        );

        let inferred = parse_attachment_message("hi\n\nattachments:\n- [a]: /abs/a.png\n- [b]: /abs/b.txt");
        assert_eq!(
            inferred.attachments,
            [
                att(Some("[a]"), AttachmentKind::Image, "/abs/a.png"),
                att(Some("[b]"), AttachmentKind::File, "/abs/b.txt")
            ]
        );

        let legacy = parse_attachment_message("x\n\nattachments:\n- {image #1}: /abs/a.png\n- folder: /abs/docs");
        assert_eq!(
            legacy.attachments,
            [
                att(Some("{image #1}"), AttachmentKind::Image, "/abs/a.png"),
                att(None, AttachmentKind::Folder, "/abs/docs")
            ]
        );
    }

    #[test]
    fn writer_and_reader_agree() {
        let suffix = build_attachment_suffix(&[
            ("[a.png]", "/abs/a.png", Some(AttachmentKind::Image)),
            ("[skipped]", "", None),
            ("[b.txt]", "/abs/b.txt", Some(AttachmentKind::File)),
        ]);
        let parsed = parse_attachment_message(&format!("hi{suffix}"));
        assert_eq!(parsed.display, "hi");
        assert_eq!(
            parsed.attachments,
            [
                att(Some("[a.png]"), AttachmentKind::Image, "/abs/a.png"),
                att(Some("[b.txt]"), AttachmentKind::File, "/abs/b.txt")
            ]
        );
        assert_eq!(build_attachment_suffix(&[]), "");
    }
}
