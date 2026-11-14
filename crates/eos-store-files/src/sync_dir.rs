//! A folder of hand-editable markdown files as a sync domain: `<data
//! folder>/templates` and `<data folder>/workers`. One record per `<id>.md`,
//! plus — for templates — the files in `assets/<id>/`. The files are read fresh
//! on every use; there is no change event, so sync's periodic pass notices
//! edits. Deletes are soft (`.trash/`), like the stores that own these folders.
//!
//! Ids and asset names come from another computer, so both are checked
//! before they touch a path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use eos_contracts::SyncDomainName;
use eos_core::net::sync::SyncDomain;
use eos_core::{BoxFuture, Clock, Error};
use eos_domain::sync::SyncItem;
use eos_kit_fs::{WriteOptions, atomic_write, move_to_trash};
use serde_json::{Map, Value};

/// What the TypeScript's `Buffer.from(text, "base64")` accepts: padding or
/// not, loose trailing bits.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

/// `^[a-z0-9][a-z0-9-]*$`: a template's name.
pub fn is_template_id(id: &str) -> bool {
    let ok = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    id.bytes().next().is_some_and(ok) && id.bytes().all(|b| ok(b) || b == b'-')
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$`: a worker definition's file name.
pub fn is_worker_id(id: &str) -> bool {
    id.len() <= 121
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `^[^/\\\0.][^/\\\0]{0,200}$`, counted in UTF-16 units as the TypeScript does.
fn is_asset_name(name: &str) -> bool {
    let plain = |c: char| !matches!(c, '/' | '\\' | '\0');
    name.chars().next().is_some_and(|c| plain(c) && c != '.')
        && name.chars().all(plain)
        && name.encode_utf16().count() <= 201
}

pub struct FileDirDomain {
    name: SyncDomainName,
    dir: PathBuf,
    is_id: fn(&str) -> bool,
    with_assets: bool,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FileDirDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileDirDomain").field("name", &self.name).field("dir", &self.dir).finish_non_exhaustive()
    }
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6)
}

impl FileDirDomain {
    /// The user's prompt templates: `<data folder>/templates`, with each
    /// template's attached files.
    pub fn templates(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        Self { name: SyncDomainName::Template, dir: dir.into(), is_id: is_template_id, with_assets: true, clock }
    }

    /// The user's worker definitions: `<data folder>/workers`.
    pub fn workers(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        Self { name: SyncDomainName::Worker, dir: dir.into(), is_id: is_worker_id, with_assets: false, clock }
    }

    fn md_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.md"))
    }

    fn asset_dir(&self, id: &str) -> PathBuf {
        self.dir.join("assets").join(id)
    }

    fn check_id(&self, id: &str) -> Result<(), Error> {
        if (self.is_id)(id) { Ok(()) } else { Err(Error::Validation(format!("invalid {} id {id}", self.label()))) }
    }

    fn label(&self) -> &'static str {
        if self.name == SyncDomainName::Template { "template" } else { "worker" }
    }

    /// The record's attached files by name, base64; `None` when it has none.
    fn read_assets(&self, id: &str) -> Result<Option<Map<String, Value>>, Error> {
        if !self.with_assets {
            return Ok(None);
        }
        let Ok(entries) = fs::read_dir(self.asset_dir(id)) else { return Ok(None) };
        let mut names: Vec<String> =
            entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        let mut out = Map::new();
        for name in names.into_iter().filter(|name| is_asset_name(name)) {
            let path = self.asset_dir(id).join(&name);
            if path.is_file() {
                out.insert(name, Value::String(STANDARD.encode(fs::read(&path).map_err(Error::storage)?)));
            }
        }
        Ok((!out.is_empty()).then_some(out))
    }

    fn read(&self, id: &str) -> Result<Option<SyncItem>, Error> {
        let path = self.md_path(id);
        if !(self.is_id)(id) || !path.exists() {
            return Ok(None);
        }
        let md = String::from_utf8_lossy(&fs::read(&path).map_err(Error::storage)?).into_owned();
        let mut data = Map::new();
        data.insert("md".to_owned(), Value::String(md));
        if let Some(assets) = self.read_assets(id)? {
            data.insert("assets".to_owned(), Value::Object(assets));
        }
        Ok(Some(SyncItem { id: id.to_owned(), data: Value::Object(data), updated_at: mtime_ms(&path) }))
    }

    fn list_now(&self) -> Result<Vec<SyncItem>, Error> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Ok(Vec::new()) };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_string_lossy().strip_suffix(".md").map(str::to_owned))
            .collect();
        ids.sort();
        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            items.extend(self.read(&id)?);
        }
        Ok(items)
    }

    fn apply_now(&self, id: &str, data: &Value) -> Result<(), Error> {
        self.check_id(id)?;
        let refused = || Error::Validation(format!("invalid {} record {id}", self.label()));
        let record = data.as_object().ok_or_else(refused)?;
        let md = record.get("md").and_then(Value::as_str).ok_or_else(refused)?;
        let mut assets: Vec<(&str, Vec<u8>)> = Vec::new();
        match record.get("assets") {
            None => {}
            Some(Value::Object(listed)) => {
                for (name, encoded) in listed {
                    let encoded = encoded.as_str().filter(|_| is_asset_name(name)).ok_or_else(refused)?;
                    assets.push((name, LENIENT.decode(encoded).map_err(|_| refused())?));
                }
            }
            Some(_) => return Err(refused()),
        }
        if self.with_assets {
            let dir = self.asset_dir(id);
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if assets.iter().any(|(keep, _)| *keep == name.to_string_lossy()) {
                        continue;
                    }
                    let path = entry.path();
                    let removed = if path.is_dir() && !path.is_symlink() {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    };
                    removed.map_err(Error::storage)?;
                }
            }
            for (name, bytes) in &assets {
                atomic_write(&dir.join(name), bytes, &WriteOptions::default()).map_err(Error::storage)?;
            }
        }
        atomic_write(&self.md_path(id), md.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
    }

    fn remove_now(&self, id: &str) -> Result<(), Error> {
        self.check_id(id)?;
        let now_ms = u64::try_from(self.clock.now_ms()).unwrap_or_default();
        move_to_trash(&self.dir, id, "md", UNIX_EPOCH + Duration::from_millis(now_ms)).map_err(Error::storage)?;
        let assets = self.asset_dir(id);
        if self.with_assets && assets.exists() {
            let trash = self.dir.join(".trash").join("assets");
            fs::create_dir_all(&trash).map_err(Error::storage)?;
            fs::rename(&assets, trash.join(format!("{id}.{now_ms}"))).map_err(Error::storage)?;
        }
        Ok(())
    }
}

impl SyncDomain for FileDirDomain {
    fn name(&self) -> SyncDomainName {
        self.name
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(std::future::ready(self.list_now()))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(std::future::ready(self.read(id)))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.apply_now(id, data)))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.remove_now(id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_asset_names_follow_todays_patterns() {
        for (id, ok) in [("review", true), ("a-1", true), ("-a", false), ("A", false), ("a.b", false), ("", false)] {
            assert_eq!(is_template_id(id), ok, "{id:?}");
        }
        let long = "a".repeat(121);
        let too_long = "a".repeat(122);
        for (id, ok) in
            [("Reviewer", true), ("code.review_v2-x", true), (".hidden", false), ("a/b", false), ("", false)]
        {
            assert_eq!(is_worker_id(id), ok, "{id:?}");
        }
        assert!(is_worker_id(&long) && !is_worker_id(&too_long));
        for (name, ok) in [
            ("shot.png", true),
            ("a b", true),
            (".hidden", false),
            ("../x", false),
            ("a/b", false),
            ("a\\b", false),
            ("", false),
        ] {
            assert_eq!(is_asset_name(name), ok, "{name:?}");
        }
        assert!(is_asset_name(&"x".repeat(201)) && !is_asset_name(&"x".repeat(202)));
    }
}
