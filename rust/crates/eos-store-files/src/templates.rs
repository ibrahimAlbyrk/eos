//! The user's prompt templates (`manager/services/UserTemplateService.ts`):
//! `<data folder>/templates/<name>.md`, YAML frontmatter (`description`,
//! `attachments`) and the prompt as the body. Files stay hand-editable and
//! are read fresh on every call.
//!
//! Attached files are copied into `templates/assets/<name>/` when a template
//! is saved, so a template still finds them weeks later; their paths are
//! stored relative to the templates folder and read back absolute. Folder
//! references are kept as they are. Deleting moves the file (and its assets)
//! to `templates/.trash/`, so a wrong click can be undone by hand.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use eos_contracts::{Template, TemplateAttachment, TemplateAttachmentKind, TemplateName};
use eos_core::store::TemplateStore;
use eos_core::{Clock, Error};
use eos_kit_fs::path::normalize;
use eos_kit_fs::{WriteOptions, atomic_write, frontmatter, move_to_trash, to_yaml, trash_stamp};
use serde_json::{Value, json};

use crate::yaml_value;

pub struct FsTemplateStore {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FsTemplateStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsTemplateStore").field("dir", &self.dir).finish_non_exhaustive()
    }
}

/// `^[a-z0-9][a-z0-9-]*$`: a template's name is its file name.
fn is_name(name: &str) -> bool {
    let ok = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    name.bytes().next().is_some_and(ok) && name.bytes().all(|b| ok(b) || b == b'-')
}

fn check_name(name: &str) -> Result<(), Error> {
    if is_name(name) { Ok(()) } else { Err(Error::Validation(format!("invalid template name: {name}"))) }
}

/// What JavaScript's `trim` removes.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn kind_of(name: &str) -> Option<TemplateAttachmentKind> {
    match name {
        "image" => Some(TemplateAttachmentKind::Image),
        "file" => Some(TemplateAttachmentKind::File),
        "folder" => Some(TemplateAttachmentKind::Folder),
        _ => None,
    }
}

fn kind_name(kind: TemplateAttachmentKind) -> &'static str {
    match kind {
        TemplateAttachmentKind::Image => "image",
        TemplateAttachmentKind::File => "file",
        TemplateAttachmentKind::Folder => "folder",
    }
}

/// The attachments a frontmatter lists; an entry that is not one is skipped.
fn stored_attachments(meta: &Value) -> Vec<TemplateAttachment> {
    let Some(items) = meta.get("attachments").and_then(Value::as_array) else { return Vec::new() };
    items
        .iter()
        .filter_map(|item| {
            Some(TemplateAttachment {
                label: item.get("label")?.as_str()?.to_owned(),
                kind: item.get("kind")?.as_str().and_then(kind_of)?,
                path: item.get("path")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

/// `first-2.png`, `first-3.png`, …: the first name in `dir` nothing has yet.
fn unique_dest(dir: &Path, filename: &str) -> PathBuf {
    let first = dir.join(filename);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match filename.rfind('.') {
        Some(dot) if dot > 0 => filename.split_at(dot),
        _ => (filename, ""),
    };
    (2u32..).map(|n| dir.join(format!("{stem}-{n}{ext}"))).find(|dest| !dest.exists()).unwrap_or(first)
}

impl FsTemplateStore {
    /// `dir` is `<data folder>/templates`; it is created on the first save.
    pub fn new(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        Self { dir: dir.into(), clock }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.md"))
    }

    fn asset_dir(&self, name: &str) -> PathBuf {
        self.dir.join("assets").join(name)
    }

    /// A stored path made absolute: a relative one points into this folder.
    fn absolute(&self, path: &str) -> PathBuf {
        if Path::new(path).is_absolute() { PathBuf::from(path) } else { normalize(&self.dir.join(path)) }
    }

    /// A path inside this folder as it is stored: relative, with `/`.
    fn stored_path(&self, abs: &Path) -> String {
        let relative = abs.strip_prefix(normalize(&self.dir)).unwrap_or(abs);
        relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
    }

    fn read(&self, name: &str) -> Result<Template, Error> {
        check_name(name)?;
        let raw = fs::read_to_string(self.file(name)).map_err(Error::storage)?;
        // Frontmatter that is not YAML is ignored; the body is still the prompt.
        let (meta, body) = match frontmatter::split(&raw) {
            Some((yaml, body)) => (yaml_value::parse(yaml).unwrap_or(Value::Null), body),
            None => (Value::Null, raw.as_str()),
        };
        let attachments = stored_attachments(&meta)
            .into_iter()
            .map(|a| TemplateAttachment { path: self.absolute(&a.path).to_string_lossy().into_owned(), ..a })
            .collect();
        Ok(Template {
            name: TemplateName(name.to_owned()),
            description: meta.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
            content: body.trim_matches(is_js_whitespace).to_owned(),
            attachments,
        })
    }

    /// Copies attached files into the template's own folder and answers the
    /// attachments as they are stored. A file already there is kept (saving
    /// twice copies once); a source that is gone is dropped.
    fn promote(&self, name: &str, attachments: &[TemplateAttachment]) -> Result<Vec<TemplateAttachment>, Error> {
        let asset_dir = normalize(&self.asset_dir(name));
        let mut out = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            if attachment.kind == TemplateAttachmentKind::Folder {
                out.push(attachment.clone());
                continue;
            }
            let abs = self.absolute(&attachment.path);
            if !abs.exists() {
                continue;
            }
            let inside = normalize(&abs).strip_prefix(&asset_dir).is_ok_and(|rest| !rest.as_os_str().is_empty());
            let kept = if inside {
                normalize(&abs)
            } else {
                fs::create_dir_all(&asset_dir).map_err(Error::storage)?;
                let filename =
                    abs.file_name().map(|n| n.to_string_lossy().replace(['/', '\0'], "_")).unwrap_or_default();
                let dest = unique_dest(&asset_dir, &filename);
                fs::copy(&abs, &dest).map_err(Error::storage)?;
                dest
            };
            out.push(TemplateAttachment { path: self.stored_path(&kept), ..attachment.clone() });
        }
        Ok(out)
    }
}

impl TemplateStore for FsTemplateStore {
    fn list(&self) -> Result<Vec<Template>, Error> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Ok(Vec::new()) };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_string_lossy().strip_suffix(".md").map(str::to_owned))
            .collect();
        names.sort();
        Ok(names.iter().filter_map(|name| self.read(name).ok()).collect())
    }

    fn exists(&self, name: &str) -> Result<bool, Error> {
        check_name(name)?;
        Ok(self.file(name).exists())
    }

    fn write(&self, template: &Template) -> Result<(), Error> {
        let name = template.name.0.as_str();
        check_name(name)?;
        fs::create_dir_all(&self.dir).map_err(Error::storage)?;
        let attachments = self.promote(name, &template.attachments)?;
        let mut meta = serde_json::Map::new();
        meta.insert("description".to_owned(), Value::String(template.description.clone()));
        if !attachments.is_empty() {
            let stored: Vec<Value> = attachments
                .iter()
                .map(|a| json!({ "label": a.label, "kind": kind_name(a.kind), "path": a.path }))
                .collect();
            meta.insert("attachments".to_owned(), Value::Array(stored));
        }
        let yaml = to_yaml(&Value::Object(meta)).map_err(Error::storage)?;
        let text = format!(
            "---\n{}\n---\n\n{}\n",
            yaml.trim_end_matches(is_js_whitespace),
            template.content.trim_matches(is_js_whitespace)
        );
        atomic_write(&self.file(name), text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
    }

    fn delete(&self, name: &str) -> Result<bool, Error> {
        check_name(name)?;
        let now = UNIX_EPOCH + Duration::from_millis(u64::try_from(self.clock.now_ms()).unwrap_or_default());
        if !move_to_trash(&self.dir, name, "md", now).map_err(Error::storage)? {
            return Ok(false);
        }
        let assets = self.asset_dir(name);
        if assets.exists() {
            let trash = self.dir.join(".trash").join("assets");
            fs::create_dir_all(&trash).map_err(Error::storage)?;
            fs::rename(&assets, trash.join(format!("{name}.{}", trash_stamp(now)))).map_err(Error::storage)?;
        }
        Ok(true)
    }
}
