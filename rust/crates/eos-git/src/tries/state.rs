//! A checkout's Tries on disk, in today's format: `<tries>/<repo key>/`
//! holds `tries.json` (the stack, oldest first, pretty-printed as
//! `JSON.stringify(…, null, 2)` writes it), `<worker key>.patch` (each
//! layer's whole patch) and, from older versions, `kept.json`, `try.json` and
//! `try.patch`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use eos_contracts::ActiveTry;
use eos_kit_fs::{WriteOptions, atomic_write};
use serde::{Deserialize, Serialize};

/// One file a layer touched and its content right after the apply (`None`:
/// the layer removed it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LayerFile {
    pub(crate) path: String,
    pub(crate) hash: Option<String>,
}

/// One worker's Try in the stack. Fields in today's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Layer {
    pub(crate) worker_id: String,
    pub(crate) branch: String,
    pub(crate) base_head: String,
    /// The snapshot it holds: what a later sync compares against, and the
    /// stack's fallback when the snapshot ref is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_sha: Option<String>,
    /// Accepted: out of the deck, still in the stack and still syncable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kept: Option<bool>,
    pub(crate) lockfile_changed: bool,
    pub(crate) created_at: i64,
    pub(crate) files: Vec<LayerFile>,
}

impl Layer {
    pub(crate) fn is_kept(&self) -> bool {
        self.kept == Some(true)
    }

    pub(crate) fn touches(&self, path: &str) -> bool {
        self.files.iter().any(|f| f.path == path)
    }

    pub(crate) fn to_active(&self) -> ActiveTry {
        ActiveTry {
            worker_id: self.worker_id.clone(),
            branch: self.branch.clone(),
            base_head: self.base_head.clone(),
            files: self.files.iter().map(|f| f.path.clone()).collect(),
            lockfile_changed: self.lockfile_changed,
            created_at: self.created_at.into(),
        }
    }
}

/// A name made safe for a file: every UTF-16 unit that is not an ASCII
/// letter, digit, `_` or `-` becomes `-`, as today's code names these files.
pub(crate) fn file_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

/// The files of one checkout's Tries.
pub(crate) struct StateDir {
    pub(crate) dir: PathBuf,
}

impl StateDir {
    pub(crate) fn new(tries_dir: &Path, real_root: &Path) -> Self {
        Self { dir: tries_dir.join(file_key(&real_root.to_string_lossy())) }
    }

    fn tries_path(&self) -> PathBuf {
        self.dir.join("tries.json")
    }

    pub(crate) fn patch_path(&self, worker_id: &str) -> PathBuf {
        self.dir.join(format!("{}.patch", file_key(worker_id)))
    }

    pub(crate) fn apply_tmp_path(&self, worker_id: &str) -> PathBuf {
        self.dir.join(format!("{}.apply.tmp", file_key(worker_id)))
    }

    /// The single Try of older versions (`try.json` + `try.patch`) becomes a
    /// stack of one. Best effort, as today.
    fn migrate_legacy(&self) {
        let legacy = self.dir.join("try.json");
        if !legacy.exists() || self.tries_path().exists() {
            return;
        }
        let Some(layer) = fs::read(&legacy).ok().and_then(|bytes| serde_json::from_slice::<Layer>(&bytes).ok()) else {
            return;
        };
        let patch = self.dir.join("try.patch");
        if patch.exists() && fs::rename(&patch, self.patch_path(&layer.worker_id)).is_err() {
            return;
        }
        if self.write(&[layer]).is_ok() {
            let _ = fs::remove_file(legacy);
        }
    }

    /// The stack, oldest first; empty when there is none or it cannot be read.
    pub(crate) fn load(&self) -> Vec<Layer> {
        self.migrate_legacy();
        fs::read(self.tries_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn write(&self, tries: &[Layer]) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let text = serde_json::to_string_pretty(tries).map_err(std::io::Error::other)?;
        atomic_write(&self.tries_path(), text.as_bytes(), &WriteOptions::default()).map_err(std::io::Error::other)
    }

    /// Writes the stack; an empty one removes the file. `kept.json` is never touched.
    pub(crate) fn save(&self, tries: &[Layer]) -> std::io::Result<()> {
        if !tries.is_empty() {
            return self.write(tries);
        }
        match fs::remove_file(self.tries_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Workers kept by versions that dropped a kept layer from the stack.
    pub(crate) fn legacy_kept(&self) -> HashMap<String, serde_json::Value> {
        fs::read(self.dir.join("kept.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_key_replaces_each_utf16_unit_it_cannot_keep() {
        assert_eq!(file_key("/Users/me/my repo"), "-Users-me-my-repo");
        assert_eq!(file_key("w-1_a"), "w-1_a");
        assert_eq!(file_key("é😀"), "---");
    }

    #[test]
    fn the_stack_is_written_as_today() {
        let layer = Layer {
            worker_id: "w-1".into(),
            branch: "eos-w1".into(),
            base_head: "abc".into(),
            snapshot_sha: Some("def".into()),
            kept: Some(false),
            lockfile_changed: false,
            created_at: 1000,
            files: vec![LayerFile { path: "a.txt".into(), hash: None }],
        };
        let text = serde_json::to_string_pretty(&[layer]).expect("serializes");
        let expected = "[\n  {\n    \"workerId\": \"w-1\",\n    \"branch\": \"eos-w1\",\n    \"baseHead\": \"abc\",\n    \"snapshotSha\": \"def\",\n    \"kept\": false,\n    \"lockfileChanged\": false,\n    \"createdAt\": 1000,\n    \"files\": [\n      {\n        \"path\": \"a.txt\",\n        \"hash\": null\n      }\n    ]\n  }\n]";
        assert_eq!(text, expected);
    }
}
