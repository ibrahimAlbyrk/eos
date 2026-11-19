use std::sync::Mutex;

use eos_core::Error;
use eos_core::policy::{PolicyDocument, PolicyFile};
use serde_json::Value;

/// A policy file held in memory: the user's document, with no bundled one
/// behind it.
#[derive(Debug, Default)]
pub struct FakePolicyFile {
    document: Mutex<Option<Value>>,
}

impl FakePolicyFile {
    /// No policy file at all.
    pub fn missing() -> Self {
        Self::default()
    }

    /// The policy the app ships, as a user's file: what a user who never
    /// edited theirs runs under.
    pub fn bundled() -> Self {
        let missing = std::env::temp_dir().join("eos-testkit-no-policy").join("policy.yaml");
        match eos_store_files::policy::YamlPolicyFile::new(missing).load() {
            PolicyDocument::Parsed { value, .. } => Self::holding(value),
            other => panic!("the bundled policy does not parse: {other:?}"),
        }
    }

    /// A user's file holding `document`.
    pub fn holding(document: Value) -> Self {
        Self { document: Mutex::new(Some(document)) }
    }

    /// What the user's file holds now.
    pub fn document(&self) -> Option<Value> {
        self.document.lock().expect("the document").clone()
    }
}

impl PolicyFile for FakePolicyFile {
    fn load(&self) -> PolicyDocument {
        match self.document() {
            Some(value) => PolicyDocument::Parsed { source: "policy.yaml".to_owned(), value },
            None => PolicyDocument::Missing,
        }
    }

    fn read_user(&self) -> Result<Option<Value>, Error> {
        Ok(self.document())
    }

    fn write_user(&self, document: &Value) -> Result<(), Error> {
        *self.document.lock().expect("the document") = Some(document.clone());
        Ok(())
    }
}
