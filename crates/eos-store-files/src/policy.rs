//! `policy.yaml`.
//!
//! The user's file is `<data folder>/policy.yaml`; when it does not exist the
//! policy in force is the example bundled with the app. Saving re-writes the
//! user's file as the `yaml` package would: comments and flow style are not kept.

use std::fs;
use std::io;
use std::path::PathBuf;

use eos_core::Error;
use eos_core::policy::{PolicyDocument, PolicyFile};
use eos_kit_fs::{WriteOptions, atomic_write, to_yaml};
use serde_json::Value;

use crate::yaml_value;

/// The policy shipped with the app: everything allowed except a few
/// destructive commands.
pub const BUNDLED_POLICY: &str = include_str!("../assets/policy.example.yaml");

const BUNDLED_SOURCE: &str = "policy.example.yaml (bundled)";

#[derive(Debug, Clone)]
pub struct YamlPolicyFile {
    user: PathBuf,
}

impl YamlPolicyFile {
    /// `user` is the user's own file; it need not exist.
    pub fn new(user: impl Into<PathBuf>) -> Self {
        Self { user: user.into() }
    }

    fn read(&self) -> io::Result<Option<String>> {
        match fs::read_to_string(&self.user) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
}

fn document(source: String, text: &str) -> PolicyDocument {
    match yaml_value::parse(text) {
        Ok(value) => PolicyDocument::Parsed { source, value },
        Err(error) => PolicyDocument::Unreadable { source, error },
    }
}

impl PolicyFile for YamlPolicyFile {
    fn load(&self) -> PolicyDocument {
        let source = self.user.display().to_string();
        match self.read() {
            Ok(Some(text)) => document(source, &text),
            Ok(None) => document(BUNDLED_SOURCE.to_owned(), BUNDLED_POLICY),
            // A file that is there but cannot be read is a broken policy, not a missing one.
            Err(e) => PolicyDocument::Unreadable { source, error: e.to_string() },
        }
    }

    fn read_user(&self) -> Result<Option<Value>, Error> {
        let Some(text) = self.read().map_err(Error::storage)? else { return Ok(None) };
        if text.is_empty() {
            return Ok(None);
        }
        yaml_value::parse(&text).map(Some).map_err(Error::Storage)
    }

    fn write_user(&self, document: &Value) -> Result<(), Error> {
        let text = to_yaml(document).map_err(Error::storage)?;
        atomic_write(&self.user, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
    }
}
