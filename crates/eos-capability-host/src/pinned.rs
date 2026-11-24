//! Code from elsewhere (06 G12): a package that runs a published server is
//! held to its pin before Eos tests it. Its lock file names the pinned
//! version with the pinned integrity hash, every package it installed came
//! from the registry with a hash of its own, and nothing is linked in from
//! outside. What it installed is listed for the proposal, and so are the
//! packages that declare install scripts: those must stay off
//! (`npm install --ignore-scripts`), and the reviewer reads them.

use std::path::Path;

use eos_contracts::ForgePackage;
use serde_json::Value;

/// npm's registry: every installed package comes from it.
const NPM_REGISTRY: &str = "https://registry.npmjs.org/";
/// The largest lock file read.
const LOCK_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// What a pinned package installed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Pinned {
    /// `name@version`, in the lock file's order.
    pub dependencies: Vec<String>,
    /// The installed packages that declare install scripts.
    pub install_scripts: Vec<String>,
}

/// Holds the package folder `dir` to `pin`; why not, in Eos's words.
pub fn check_pin(dir: &Path, pin: &ForgePackage) -> Result<Pinned, String> {
    match pin.registry.as_str() {
        "npm" => npm(dir, pin),
        "pypi" => pypi(dir, pin),
        other => Err(format!("Eos does not install packages from {other}")),
    }
}

fn read(path: &Path, what: &str) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| format!("the package has no {what}"))?;
    if !meta.is_file() || meta.len() > LOCK_MAX_BYTES {
        return Err(format!("its {what} is no plain file of at most 8 MiB"));
    }
    std::fs::read_to_string(path).map_err(|_| format!("its {what} could not be read"))
}

fn npm(dir: &Path, pin: &ForgePackage) -> Result<Pinned, String> {
    let lock: Value = serde_json::from_str(&read(&dir.join("package-lock.json"), "package-lock.json")?)
        .map_err(|_| "its package-lock.json is not JSON".to_owned())?;
    if lock["lockfileVersion"].as_i64().unwrap_or(0) < 2 {
        return Err("its package-lock.json is older than npm 7's".into());
    }
    let Some(packages) = lock["packages"].as_object() else {
        return Err("its package-lock.json lists no packages".into());
    };
    let mut pinned = Pinned::default();
    for (key, entry) in packages.iter().filter(|(key, _)| !key.is_empty()) {
        let name = key.rsplit_once("node_modules/").map_or(key.as_str(), |(_, name)| name);
        let version = entry["version"].as_str().unwrap_or_default();
        if entry["link"].as_bool() == Some(true) {
            return Err(format!("{name} is linked in from outside the registry"));
        }
        let from_registry = entry["resolved"].as_str().is_some_and(|url| url.starts_with(NPM_REGISTRY));
        let hashed = entry["integrity"].as_str().is_some_and(|hash| hash.starts_with("sha512-"));
        if !from_registry || !hashed {
            return Err(format!("{name}@{version} did not come from npm's registry with a sha512 integrity"));
        }
        if entry["hasInstallScript"].as_bool() == Some(true) {
            pinned.install_scripts.push(format!("{name}@{version}"));
        }
        pinned.dependencies.push(format!("{name}@{version}"));
    }
    let top = &packages.get(&format!("node_modules/{}", pin.name)).cloned().unwrap_or(Value::Null);
    if top["version"].as_str() != Some(pin.version.as_str()) {
        return Err(format!("its lock file does not install {} {}", pin.name, pin.version));
    }
    if top["integrity"].as_str() != Some(pin.integrity.as_str()) {
        return Err(format!("{} {} is locked with another integrity hash than the pinned one", pin.name, pin.version));
    }
    let installed = read(&dir.join("node_modules").join(&pin.name).join("package.json"), "installed package")?;
    let installed: Value = serde_json::from_str(&installed).map_err(|_| "the installed package.json is not JSON")?;
    if installed["version"].as_str() != Some(pin.version.as_str()) {
        return Err(format!("the installed {} is not version {}", pin.name, pin.version));
    }
    Ok(pinned)
}

/// A PyPI package is installed from a `requirements.txt` that pins every
/// package with its hash (`pip install --require-hashes`).
fn pypi(dir: &Path, pin: &ForgePackage) -> Result<Pinned, String> {
    let text = read(&dir.join("requirements.txt"), "requirements.txt")?;
    let mut pinned = Pinned::default();
    let mut found = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
        let mut words = line.split_whitespace();
        let requirement = words.next().unwrap_or_default();
        let Some((name, version)) = requirement.split_once("==") else {
            return Err(format!("{requirement} is not pinned to one version"));
        };
        let hashes: Vec<&str> = words.filter_map(|word| word.strip_prefix("--hash=")).collect();
        if hashes.is_empty() || !hashes.iter().all(|hash| hash.starts_with("sha256:")) {
            return Err(format!("{name} {version} has no sha256 hash"));
        }
        if name.eq_ignore_ascii_case(&pin.name) {
            if version != pin.version || !hashes.contains(&pin.integrity.as_str()) {
                return Err(format!("{} is required in another version or hash than the pinned one", pin.name));
            }
            found = true;
        }
        pinned.dependencies.push(format!("{name}@{version}"));
    }
    if !found {
        return Err(format!("its requirements.txt does not install {}", pin.name));
    }
    Ok(pinned)
}
