//! A plugin from the npm registry: its tarball, checked against the
//! registry's own sha512, unpacked by hand.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use eos_contracts::PluginSourceNpm;
use eos_core::plugin::FetchedPlugin;
use eos_core::{BoxFuture, Error};
use eos_kit_net::{SafeFetcher, SafeGetOptions};
use serde_json::Value;
use sha2::{Digest, Sha512};

use super::blocking;
use crate::tarball::{PackageLimits, extract_tar_gz};

pub const NPM_REGISTRY: &str = "https://registry.npmjs.org";

const TIMEOUT: Duration = Duration::from_secs(60);
/// A package's version list. The largest on npm are a few megabytes.
const MAX_METADATA_BYTES: usize = 32 * 1024 * 1024;
/// Says who is asking without saying who the user is.
const USER_AGENT: &str = "Eos plugin installer";

/// Why a GET produced no body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpFailure {
    /// The server answered, with this status.
    Status(u16),
    /// The body is larger than the caller accepts.
    TooLarge,
    /// No answer: the name did not resolve, the connection failed, it took too long.
    Unreachable(String),
}

/// The GET the npm source makes, so tests can stand in for the registry.
pub trait RegistryHttp: Send + Sync + 'static {
    /// The body of `url` (redirects followed), `max_bytes` at most.
    fn get<'a>(
        &'a self,
        url: &'a str,
        accept: Option<&'a str>,
        max_bytes: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>>;
}

/// The registry over the guarded fetch: public addresses only, every
/// redirect re-checked, one deadline, the body capped while it is read.
#[derive(Debug, Clone)]
pub struct GuardedHttp(pub SafeFetcher);

impl RegistryHttp for GuardedHttp {
    fn get<'a>(
        &'a self,
        url: &'a str,
        accept: Option<&'a str>,
        max_bytes: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
        Box::pin(async move {
            let mut options = SafeGetOptions::new(USER_AGENT, max_bytes);
            options.timeout = TIMEOUT;
            options.accept = accept.map(str::to_owned);
            match self.0.get(url, &options).await {
                Ok(response) => Ok(response.body.to_vec()),
                Err(eos_kit_net::Error::Status(status)) => Err(HttpFailure::Status(status)),
                Err(eos_kit_net::Error::TooLarge(_)) => Err(HttpFailure::TooLarge),
                Err(other) => Err(HttpFailure::Unreachable(other.to_string())),
            }
        })
    }
}

fn invalid(message: String) -> Error {
    Error::Validation(message)
}

async fn get(
    http: &dyn RegistryHttp,
    url: &str,
    what: &str,
    accept: Option<&str>,
    max: usize,
) -> Result<Vec<u8>, Error> {
    http.get(url, accept, max).await.map_err(|failure| {
        invalid(match failure {
            HttpFailure::Status(404) => format!("{what} isn't on npm"),
            HttpFailure::Status(status) => format!("the npm registry answered {status} for {what}"),
            HttpFailure::TooLarge => format!("{what} is too big for a plugin"),
            HttpFailure::Unreachable(why) => format!("couldn't reach the npm registry for {what}: {why}"),
        })
    })
}

/// The base64 of the registry's sha512 for a version, from its integrity
/// string (hashes separated by spaces; only sha512 counts).
fn sha512_of(integrity: &str) -> Option<&str> {
    let hash = integrity.split_whitespace().find_map(|hash| hash.strip_prefix("sha512-"))?;
    let base64 = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=');
    (!hash.is_empty() && hash.chars().all(base64)).then_some(hash)
}

pub(super) async fn fetch(
    http: &dyn RegistryHttp,
    registry: &str,
    source: &PluginSourceNpm,
    dir: &Path,
    limits: PackageLimits,
) -> Result<FetchedPlugin, Error> {
    let name = &source.name;
    let url = format!("{registry}/{}", name.replacen('/', "%2f", 1));
    let body = get(http, &url, name, Some("application/vnd.npm.install-v1+json"), MAX_METADATA_BYTES).await?;
    let meta: Value = serde_json::from_slice(&body)
        .map_err(|_| invalid(format!("the npm registry's answer for {name} isn't a package description")))?;

    let wanted = source.version.as_deref().unwrap_or("latest");
    let version = meta["dist-tags"][wanted].as_str().unwrap_or(wanted);
    let dist = &meta["versions"][version]["dist"];
    let Some(tarball) = dist["tarball"].as_str().filter(|url| !url.is_empty()) else {
        return Err(invalid(format!("{name} has no version or tag \"{wanted}\"")));
    };
    let what = format!("{name}@{version}");
    let Some(expected) = sha512_of(dist["integrity"].as_str().unwrap_or_default()) else {
        return Err(invalid(format!("{what} has no sha512 integrity hash on the registry — not installing it")));
    };
    if !tarball.starts_with("https://") {
        return Err(invalid(format!("{what}'s tarball isn't served over https")));
    }

    let tgz = get(http, tarball, &what, None, limits.bytes as usize).await?;
    if STANDARD.encode(Sha512::digest(&tgz)) != expected {
        return Err(invalid(format!("{what} doesn't match the registry's integrity hash — not installing it")));
    }
    let fetched = FetchedPlugin { resolved: tarball.to_owned(), integrity: Some(format!("sha512-{expected}")) };
    let dir = dir.to_owned();
    blocking(move || extract_tar_gz(&tgz, &dir, limits).map_err(|e| invalid(format!("{what}: {e}")))).await?;
    Ok(fetched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tarball::PACKAGE_LIMITS;
    use crate::tarball::testing::tgz;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const MANIFEST: &[u8] = br#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;

    /// A registry in memory: URL → body. Anything else is a 404.
    #[derive(Default)]
    struct FakeRegistry {
        pages: HashMap<String, Vec<u8>>,
        asked: Mutex<Vec<(String, Option<String>)>>,
    }

    impl RegistryHttp for FakeRegistry {
        fn get<'a>(
            &'a self,
            url: &'a str,
            accept: Option<&'a str>,
            max_bytes: usize,
        ) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
            self.asked.lock().expect("the log").push((url.to_owned(), accept.map(str::to_owned)));
            let answer = match self.pages.get(url) {
                Some(body) if body.len() > max_bytes => Err(HttpFailure::TooLarge),
                Some(body) => Ok(body.clone()),
                None => Err(HttpFailure::Status(404)),
            };
            Box::pin(std::future::ready(answer))
        }
    }

    fn integrity_of(bytes: &[u8]) -> String {
        format!("sha512-{}", STANDARD.encode(Sha512::digest(bytes)))
    }

    fn registry(tarball: &[u8], integrity: Option<&str>) -> FakeRegistry {
        let integrity = integrity.map_or_else(|| integrity_of(tarball), str::to_owned);
        let meta = json!({
            "dist-tags": { "latest": "1.2.0" },
            "versions": { "1.2.0": { "dist": { "tarball": "https://reg/eos-clock/-/eos-clock-1.2.0.tgz", "integrity": integrity } } },
        });
        let mut registry = FakeRegistry::default();
        registry.pages.insert("https://reg/eos-clock".into(), meta.to_string().into_bytes());
        registry.pages.insert("https://reg/eos-clock/-/eos-clock-1.2.0.tgz".into(), tarball.to_vec());
        registry
    }

    fn npm(name: &str, version: Option<&str>) -> PluginSourceNpm {
        PluginSourceNpm { name: name.into(), version: version.map(str::to_owned) }
    }

    async fn run(registry: &FakeRegistry, source: &PluginSourceNpm, dir: &Path) -> Result<FetchedPlugin, String> {
        fetch(registry, "https://reg", source, dir, PACKAGE_LIMITS).await.map_err(|e| e.to_string())
    }

    fn is_empty(dir: &Path) -> bool {
        std::fs::read_dir(dir).expect("the folder").count() == 0
    }

    // infra/src/__tests__/plugin-install.test.ts: npm plugin fetcher
    #[tokio::test]
    async fn downloads_the_tagged_version_checks_its_integrity_and_unpacks_it() {
        let package = tgz(&[("package/plugin.json", b'0', MANIFEST)]);
        let registry = registry(&package, None);
        let dir = tempfile::tempdir().expect("a folder");
        let got = run(&registry, &npm("eos-clock", None), dir.path()).await.expect("fetches");
        assert_eq!(got.resolved, "https://reg/eos-clock/-/eos-clock-1.2.0.tgz");
        assert_eq!(got.integrity, Some(integrity_of(&package)));
        assert_eq!(std::fs::read(dir.path().join("plugin.json")).expect("the manifest"), MANIFEST);
        assert_eq!(
            *registry.asked.lock().expect("the log"),
            [
                ("https://reg/eos-clock".to_owned(), Some("application/vnd.npm.install-v1+json".to_owned())),
                ("https://reg/eos-clock/-/eos-clock-1.2.0.tgz".to_owned(), None),
            ]
        );
        // An exact version is looked up as itself.
        let dir = tempfile::tempdir().expect("a folder");
        assert!(run(&registry, &npm("eos-clock", Some("1.2.0")), dir.path()).await.is_ok());
    }

    #[tokio::test]
    async fn refuses_a_tarball_that_does_not_match_the_registrys_hash_and_unknown_versions() {
        let package = tgz(&[("package/plugin.json", b'0', MANIFEST)]);
        let bad = registry(&package, Some(&integrity_of(b"other")));
        let dir = tempfile::tempdir().expect("a folder");
        assert_eq!(
            run(&bad, &npm("eos-clock", None), dir.path()).await.expect_err("refused"),
            "eos-clock@1.2.0 doesn't match the registry's integrity hash — not installing it"
        );
        assert!(is_empty(dir.path()), "nothing of a tarball that fails its hash is unpacked");

        let good = registry(&package, None);
        assert_eq!(
            run(&good, &npm("eos-clock", Some("9.9.9")), dir.path()).await.expect_err("refused"),
            "eos-clock has no version or tag \"9.9.9\""
        );
        assert_eq!(run(&good, &npm("missing", None), dir.path()).await.expect_err("refused"), "missing isn't on npm");
    }

    #[tokio::test]
    async fn refuses_a_version_without_a_sha512_or_a_tarball_not_on_https() {
        let package = tgz(&[("package/plugin.json", b'0', MANIFEST)]);
        let dir = tempfile::tempdir().expect("a folder");
        for weak in ["", "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", "sha512-not*base64", "sha512-"] {
            assert_eq!(
                run(&registry(&package, Some(weak)), &npm("eos-clock", None), dir.path()).await.expect_err("refused"),
                "eos-clock@1.2.0 has no sha512 integrity hash on the registry — not installing it",
                "{weak:?}"
            );
        }
        // Several hashes: the sha512 among them is the one that counts.
        let both = format!("sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk= {}", integrity_of(&package));
        assert!(run(&registry(&package, Some(&both)), &npm("eos-clock", None), dir.path()).await.is_ok());

        let mut plain = FakeRegistry::default();
        let meta = json!({
            "dist-tags": { "latest": "1.0.0" },
            "versions": { "1.0.0": { "dist": { "tarball": "http://reg/x.tgz", "integrity": integrity_of(&package) } } },
        });
        plain.pages.insert("https://reg/eos-clock".into(), meta.to_string().into_bytes());
        plain.pages.insert("http://reg/x.tgz".into(), package.clone());
        let dir = tempfile::tempdir().expect("a folder");
        assert_eq!(
            run(&plain, &npm("eos-clock", None), dir.path()).await.expect_err("refused"),
            "eos-clock@1.0.0's tarball isn't served over https"
        );
        assert_eq!(plain.asked.lock().expect("the log").len(), 1, "the tarball was never asked for");
    }

    #[tokio::test]
    async fn a_scoped_name_is_one_path_segment_and_a_bad_package_names_itself() {
        let evil = tgz(&[("package/../../escape.txt", b'0', b"x")]);
        let mut scoped = FakeRegistry::default();
        let meta = json!({
            "dist-tags": { "latest": "2.0.0" },
            "versions": { "2.0.0": { "dist": { "tarball": "https://reg/t.tgz", "integrity": integrity_of(&evil) } } },
        });
        scoped.pages.insert("https://reg/@acme%2fnotes".into(), meta.to_string().into_bytes());
        scoped.pages.insert("https://reg/t.tgz".into(), evil);
        let root = tempfile::tempdir().expect("a folder");
        let dir = root.path().join("stage");
        std::fs::create_dir(&dir).expect("a folder");
        assert_eq!(
            run(&scoped, &npm("@acme/notes", None), &dir).await.expect_err("refused"),
            "@acme/notes@2.0.0: the package has a path outside its folder: ../../escape.txt"
        );
        assert!(!root.path().join("escape.txt").exists());
    }

    #[tokio::test]
    async fn a_tarball_larger_than_a_plugin_may_be_is_not_downloaded_whole() {
        let package = tgz(&[("package/plugin.json", b'0', MANIFEST)]);
        let registry = registry(&package, None);
        let dir = tempfile::tempdir().expect("a folder");
        let tiny = PackageLimits { files: 10, bytes: 16 };
        let error =
            fetch(&registry, "https://reg", &npm("eos-clock", None), dir.path(), tiny).await.expect_err("refused");
        assert_eq!(error.to_string(), "eos-clock@1.2.0 is too big for a plugin");
    }

    #[tokio::test]
    async fn registry_failures_read_as_sentences() {
        struct Down(HttpFailure);
        impl RegistryHttp for Down {
            fn get<'a>(
                &'a self,
                _: &'a str,
                _: Option<&'a str>,
                _: usize,
            ) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
                Box::pin(std::future::ready(Err(self.0.clone())))
            }
        }
        let dir = tempfile::tempdir().expect("a folder");
        let message = |failure| async {
            fetch(&Down(failure), "https://reg", &npm("eos-clock", None), dir.path(), PACKAGE_LIMITS)
                .await
                .expect_err("fails")
                .to_string()
        };
        assert_eq!(message(HttpFailure::Status(503)).await, "the npm registry answered 503 for eos-clock");
        assert_eq!(
            message(HttpFailure::Unreachable("no answer within 60 s".into())).await,
            "couldn't reach the npm registry for eos-clock: no answer within 60 s"
        );

        let mut junk = FakeRegistry::default();
        junk.pages.insert("https://reg/eos-clock".into(), b"<html>".to_vec());
        assert_eq!(
            run(&junk, &npm("eos-clock", None), dir.path()).await.expect_err("refused"),
            "the npm registry's answer for eos-clock isn't a package description"
        );
    }
}
