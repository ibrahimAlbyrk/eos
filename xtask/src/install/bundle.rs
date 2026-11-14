//! What an app bundle is, in the words the installer tells the person.

use std::fmt;
use std::path::Path;
use std::process::{Command, Stdio};

/// The installed app's identity: privacy grants, notifications and `eos://`
/// links follow it (`docs/first-rust-release.md`).
pub(crate) const APP_ID: &str = "com.ibrahimalbyrk.eos";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The Electron app of 0.1.x, with its daemon.
    TypeScript,
    /// The Rust app; one without `Resources/update.json` was built from source.
    Rust {
        from_source: bool,
    },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppInfo {
    pub(crate) id: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) kind: Kind,
}

impl AppInfo {
    pub(crate) fn read(app: &Path) -> Self {
        let plist = app.join("Contents/Info.plist");
        let frameworks = app.join("Contents/Frameworks");
        let kind = if frameworks.join("Electron Framework.framework").is_dir() {
            Kind::TypeScript
        } else if frameworks.join("Chromium Embedded Framework.framework").is_dir() {
            Kind::Rust { from_source: !app.join("Contents/Resources/update.json").is_file() }
        } else {
            Kind::Unknown
        };
        Self {
            id: plist_string(&plist, "CFBundleIdentifier"),
            version: plist_string(&plist, "CFBundleShortVersionString"),
            kind,
        }
    }
}

impl fmt::Display for AppInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.version {
            Some(version) => write!(f, "Eos {version}")?,
            None => write!(f, "Eos (version unknown)")?,
        }
        match self.kind {
            Kind::TypeScript => write!(f, " (the TypeScript app)"),
            Kind::Rust { from_source: true } => write!(f, " (the Rust app, built from source)"),
            Kind::Rust { from_source: false } => write!(f, " (the Rust app)"),
            Kind::Unknown => Ok(()),
        }
    }
}

/// One string of a property list, XML or binary.
fn plist_string(plist: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn plist(app: &Path, id: &str, version: &str) {
        fs::create_dir_all(app.join("Contents")).expect("bundle");
        fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>\n"
            ),
        )
        .expect("plist");
    }

    #[test]
    fn each_kind_of_app_is_named_with_its_version() {
        let tmp = tempfile::tempdir().expect("tmp");
        let electron = tmp.path().join("ts/Eos.app");
        plist(&electron, APP_ID, "0.1.5");
        fs::create_dir_all(electron.join("Contents/Frameworks/Electron Framework.framework")).expect("framework");
        let info = AppInfo::read(&electron);
        assert_eq!(info.id.as_deref(), Some(APP_ID));
        assert_eq!(info.to_string(), "Eos 0.1.5 (the TypeScript app)");

        let rust = tmp.path().join("rs/Eos.app");
        plist(&rust, APP_ID, "0.2.0");
        fs::create_dir_all(rust.join("Contents/Frameworks/Chromium Embedded Framework.framework")).expect("framework");
        assert_eq!(AppInfo::read(&rust).to_string(), "Eos 0.2.0 (the Rust app, built from source)");
        fs::create_dir_all(rust.join("Contents/Resources")).expect("resources");
        fs::write(rust.join("Contents/Resources/update.json"), "{}").expect("update.json");
        assert_eq!(AppInfo::read(&rust).to_string(), "Eos 0.2.0 (the Rust app)");

        let nothing = AppInfo::read(&tmp.path().join("none.app"));
        assert_eq!((nothing.id.as_deref(), nothing.to_string()), (None, "Eos (version unknown)".to_owned()));
    }
}
