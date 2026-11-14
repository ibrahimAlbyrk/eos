//! The git source of an install: the fetcher clones through its cloner and
//! records the commit the clone landed on. The clone itself is `eos-git`'s
//! (`PluginClones`, tested there against real repositories).

use std::path::Path;
use std::sync::{Arc, Mutex};

use eos_contracts::{PluginSource, PluginSourceGit};
use eos_core::plugin::{PluginCloner, PluginFetcher};
use eos_core::{BoxFuture, Error};
use eos_plugin_files::{HttpFailure, PluginFetchers, RegistryHttp};

const MANIFEST: &str = r#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;
const COMMIT: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Writes a manifest where it is asked to clone, and says which clone it was asked for.
#[derive(Default)]
struct StandIn(Mutex<Vec<(String, Option<String>)>>);

impl PluginCloner for StandIn {
    fn shallow_clone<'a>(
        &'a self,
        url: &'a str,
        reference: Option<&'a str>,
        dir: &'a Path,
    ) -> BoxFuture<'a, Result<String, Error>> {
        self.0.lock().expect("asked").push((url.to_owned(), reference.map(str::to_owned)));
        Box::pin(async move {
            std::fs::write(dir.join("plugin.json"), MANIFEST).map_err(Error::storage)?;
            Ok(COMMIT.to_owned())
        })
    }
}

struct NoRegistry;

impl RegistryHttp for NoRegistry {
    fn get<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: usize,
    ) -> eos_core::BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
        Box::pin(std::future::ready(Err(HttpFailure::Status(404))))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_git_source_records_the_commit_it_landed_on() {
    let cloner = Arc::new(StandIn::default());
    let fetchers = PluginFetchers::new(Arc::new(NoRegistry), "https://registry.invalid", cloner.clone());
    let dir = tempfile::tempdir().expect("a folder");
    let url = "https://example.invalid/clock.git";
    let source = PluginSource::Git(PluginSourceGit { url: url.to_owned(), r#ref: Some("v1".to_owned()) });
    let fetched = fetchers.fetch(&source, dir.path()).await.expect("fetches");
    assert_eq!(fetched.resolved, COMMIT);
    assert_eq!(fetched.integrity, Some(format!("git:{COMMIT}")));
    assert_eq!(*cloner.0.lock().expect("asked"), [(url.to_owned(), Some("v1".to_owned()))]);
}
