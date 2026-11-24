//! A package from elsewhere is held to its pin: version, integrity, the
//! registry every package came from, nothing linked in.

use std::path::Path;

use eos_capability_host::check_pin;
use eos_contracts::ForgePackage;
use serde_json::json;

fn integrity(fill: char) -> String {
    format!("sha512-{}==", fill.to_string().repeat(86))
}

fn pin() -> ForgePackage {
    ForgePackage {
        registry: "npm".into(),
        name: "@acme/sms-mcp".into(),
        version: "1.4.2".into(),
        integrity: integrity('A'),
        server: Some("io.github.acme/sms".into()),
    }
}

fn entry(name: &str, version: &str, hash: &str) -> serde_json::Value {
    json!({"version": version, "resolved": format!("https://registry.npmjs.org/{name}/-/x-{version}.tgz"), "integrity": hash})
}

/// A package folder whose lock file holds `packages` and whose installed
/// `@acme/sms-mcp` is `installed`.
fn package(dir: &Path, packages: serde_json::Value, installed: &str) {
    let lock = json!({"name": "sms", "lockfileVersion": 3, "packages": packages});
    std::fs::write(dir.join("package-lock.json"), lock.to_string()).expect("lock");
    let top = dir.join("node_modules/@acme/sms-mcp");
    std::fs::create_dir_all(&top).expect("folders");
    std::fs::write(top.join("package.json"), json!({"version": installed}).to_string()).expect("installed");
}

#[test]
fn a_lock_file_that_installs_the_pinned_package_from_the_registry_passes_with_its_dependencies() {
    let dir = tempfile::tempdir().expect("a folder");
    let mut helper = entry("left-pad", "1.3.0", &integrity('B'));
    helper["hasInstallScript"] = json!(true);
    let packages = json!({
        "": {"name": "sms"},
        "node_modules/@acme/sms-mcp": entry("@acme/sms-mcp", "1.4.2", &integrity('A')),
        "node_modules/@acme/sms-mcp/node_modules/left-pad": helper,
    });
    package(dir.path(), packages, "1.4.2");
    let pinned = check_pin(dir.path(), &pin()).expect("it holds to its pin");
    assert_eq!(pinned.dependencies, ["@acme/sms-mcp@1.4.2", "left-pad@1.3.0"]);
    assert_eq!(pinned.install_scripts, ["left-pad@1.3.0"]);
}

#[test]
fn another_version_hash_source_or_a_linked_package_is_refused() {
    let top = |version: &str, hash: &str| entry("@acme/sms-mcp", version, hash);
    let cases = [
        (json!({"node_modules/@acme/sms-mcp": top("1.4.3", &integrity('A'))}), "1.4.2", "does not install"),
        (json!({"node_modules/@acme/sms-mcp": top("1.4.2", &integrity('C'))}), "1.4.2", "another integrity"),
        (json!({"node_modules/@acme/sms-mcp": top("1.4.2", &integrity('A'))}), "1.5.0", "is not version"),
        (
            json!({"node_modules/@acme/sms-mcp": top("1.4.2", &integrity('A')),
                   "node_modules/evil": {"version": "1.0.0", "resolved": "https://evil.example/x.tgz", "integrity": integrity('D')}}),
            "1.4.2",
            "npm's registry",
        ),
        (
            json!({"node_modules/@acme/sms-mcp": top("1.4.2", &integrity('A')),
                   "node_modules/local": {"link": true, "resolved": "../local"}}),
            "1.4.2",
            "linked in",
        ),
    ];
    for (packages, installed, why) in cases {
        let dir = tempfile::tempdir().expect("a folder");
        package(dir.path(), packages, installed);
        let refused = check_pin(dir.path(), &pin()).expect_err(why);
        assert!(refused.contains(why), "{refused} / {why}");
    }
    let empty = tempfile::tempdir().expect("a folder");
    assert!(check_pin(empty.path(), &pin()).expect_err("no lock file").contains("package-lock.json"));
}

#[test]
fn a_pypi_package_pins_every_requirement_with_its_hash() {
    let dir = tempfile::tempdir().expect("a folder");
    let hash = format!("sha256:{}", "0f".repeat(32));
    let pypi = ForgePackage {
        registry: "pypi".into(),
        name: "acme-sms".into(),
        version: "2.0.1".into(),
        integrity: hash.clone(),
        server: None,
    };
    let write = |text: String| std::fs::write(dir.path().join("requirements.txt"), text).expect("requirements");
    write(format!("# pinned\nacme-sms==2.0.1 --hash={hash}\nhttpx==0.27.0 --hash=sha256:{}\n", "1a".repeat(32)));
    assert_eq!(check_pin(dir.path(), &pypi).expect("pinned").dependencies, ["acme-sms@2.0.1", "httpx@0.27.0"]);
    write(format!("acme-sms==2.0.1 --hash={hash}\nhttpx>=0.27\n"));
    assert!(check_pin(dir.path(), &pypi).expect_err("a range").contains("not pinned"));
    write(format!("acme-sms==2.0.1 --hash={hash}\nhttpx==0.27.0\n"));
    assert!(check_pin(dir.path(), &pypi).expect_err("no hash").contains("no sha256"));
    write(format!("acme-sms==2.0.0 --hash={hash}\n"));
    assert!(check_pin(dir.path(), &pypi).expect_err("another version").contains("another version"));
}
