use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_contracts::EDITOR_APPS;
use eos_core::os::{AppInfo, DesktopFiles, Editor, OpenIn};
use eos_core::{BoxFuture, Clock, Error};
use eos_platform::{Desktop, HostPlatform, OpenTarget};

/// How long a default-app answer is reused.
const APP_TTL_MS: i64 = 60 * 60 * 1000;
/// Answers kept; the oldest goes first.
const MAX_ANSWERS: usize = 256;

/// Editors that open a file at a line through their own URL scheme
/// (`<scheme>://file/<path>:<line>:<column>`); the others open the file only.
const LINE_URL_SCHEMES: &[(&str, &str)] = &[("vscode", "vscode"), ("cursor", "cursor")];

struct Answer {
    key: String,
    app: Option<AppInfo>,
    expires_at: i64,
}

/// The `DesktopFiles` port over the platform seam, with what the seam does
/// not keep: the answers already given (asking the system costs a process)
/// and the icons already drawn.
pub struct DesktopApps {
    host: &'static dyn HostPlatform,
    clock: Arc<dyn Clock>,
    icon_cache_dir: PathBuf,
    answers: Mutex<Vec<Answer>>,
    /// One question to the system at a time: a burst of identical lookups
    /// (a folder of same-typed files) asks once and the rest read the answer.
    asking: tokio::sync::Mutex<()>,
    drawing: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for DesktopApps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopApps").field("icon_cache_dir", &self.icon_cache_dir).finish_non_exhaustive()
    }
}

/// A bundle id as a file name.
fn sanitize_bundle_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .take(200)
        .collect()
}

fn failed(e: eos_platform::Error) -> Error {
    Error::Storage(e.to_string())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

impl DesktopApps {
    /// `icon_cache_dir` holds one PNG per app whose icon was asked for.
    pub fn new(host: &'static dyn HostPlatform, clock: Arc<dyn Clock>, icon_cache_dir: impl Into<PathBuf>) -> Self {
        let icon_cache_dir = icon_cache_dir.into();
        let _ = fs::create_dir_all(&icon_cache_dir);
        Self {
            host,
            clock,
            icon_cache_dir,
            answers: Mutex::new(Vec::new()),
            asking: tokio::sync::Mutex::new(()),
            drawing: tokio::sync::Mutex::new(()),
        }
    }

    fn desktop(&self) -> &'static dyn Desktop {
        self.host.desktop()
    }

    fn cached(&self, key: &str) -> Option<Option<AppInfo>> {
        let now = self.clock.now_ms();
        let answers = self.answers.lock().unwrap_or_else(|p| p.into_inner());
        answers.iter().find(|a| a.key == key && a.expires_at > now).map(|a| a.app.clone())
    }

    fn remember(&self, key: String, app: Option<AppInfo>) {
        let mut answers = self.answers.lock().unwrap_or_else(|p| p.into_inner());
        answers.retain(|a| a.key != key);
        if answers.len() >= MAX_ANSWERS {
            answers.remove(0);
        }
        answers.push(Answer { key, app, expires_at: self.clock.now_ms() + APP_TTL_MS });
    }

    async fn ask(&self, path: Option<String>, ext: Option<String>) -> Option<AppInfo> {
        let desktop = self.desktop();
        let found = blocking(move || {
            if let Some(path) = path.as_deref().map(Path::new).filter(|p| p.exists()) {
                return desktop.default_app(path);
            }
            // No such file: a throwaway one with the extension lets the system name the app for the type.
            let ext = ext?;
            let dir = tempfile::Builder::new().prefix("eos-app-probe-").tempdir().ok()?;
            let probe = dir.path().join(format!("probe.{ext}"));
            fs::write(&probe, b"").ok()?;
            desktop.default_app(&probe)
        })
        .await
        .flatten()?;
        Some(AppInfo { bundle_path: found.bundle_path, bundle_id: found.bundle_id, app_name: found.app_name })
    }

    fn bundle_path_of(&self, bundle_id: &str) -> Option<String> {
        let answers = self.answers.lock().unwrap_or_else(|p| p.into_inner());
        answers
            .iter()
            .find_map(|a| a.app.as_ref().filter(|app| app.bundle_id == bundle_id).map(|app| app.bundle_path.clone()))
    }
}

impl DesktopFiles for DesktopApps {
    fn resolve_default_app<'a>(
        &'a self,
        path: Option<&'a str>,
        ext: Option<&'a str>,
    ) -> BoxFuture<'a, Option<AppInfo>> {
        Box::pin(async move {
            // The extension asked for, else the one the path ends with.
            let ext = ext
                .filter(|e| !e.is_empty())
                .or_else(|| path.and_then(|p| p.rfind('.').map(|dot| &p[dot + 1..])))
                .map(str::to_owned);
            let key = match &ext {
                Some(ext) => format!("ext:{}", ext.to_lowercase()),
                None => format!("path:{}", path.unwrap_or("null")),
            };
            if let Some(known) = self.cached(&key) {
                return known;
            }
            let _turn = self.asking.lock().await;
            if let Some(known) = self.cached(&key) {
                return known;
            }
            let app = self.ask(path.map(str::to_owned), ext.filter(|e| !e.contains(['/', '\0']))).await;
            self.remember(key, app.clone());
            app
        })
    }

    fn icon_path_for_bundle_id<'a>(&'a self, bundle_id: &'a str) -> BoxFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            let out = self.icon_cache_dir.join(format!("{}.png", sanitize_bundle_id(bundle_id)));
            if out.exists() {
                return Some(out);
            }
            // The app's location is known only from an earlier default-app answer.
            let bundle_path = PathBuf::from(self.bundle_path_of(bundle_id)?);
            let _turn = self.drawing.lock().await;
            if out.exists() {
                return Some(out);
            }
            let (desktop, target) = (self.desktop(), out.clone());
            blocking(move || desktop.render_app_icon(&bundle_path, &target)).await?.ok()?;
            out.exists().then_some(out)
        })
    }

    fn open_path<'a>(&'a self, target: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let (desktop, target) = (self.desktop(), PathBuf::from(target));
        Box::pin(async move {
            blocking(move || desktop.open_path(&target))
                .await
                .unwrap_or(Err(eos_platform::Error::Unsupported("open")))
                .map_err(failed)
        })
    }

    fn reveal_path<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        let (desktop, path) = (self.desktop(), path.to_owned());
        Box::pin(async move {
            blocking(move || desktop.reveal_path(&path))
                .await
                .unwrap_or(Err(eos_platform::Error::Unsupported("reveal")))
                .map_err(failed)
        })
    }

    fn open_in<'a>(
        &'a self,
        target: OpenIn<'a>,
        path: &'a Path,
        line: Option<u32>,
        column: Option<u32>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let editor = match target {
                OpenIn::FileManager => None,
                OpenIn::Editor(id) => Some(
                    EDITOR_APPS
                        .iter()
                        .find(|(known, _)| *known == id)
                        .map(|(id, name)| (*id, *name))
                        .ok_or_else(|| Error::Validation(format!("unknown editor: {id}")))?,
                ),
            };
            let (desktop, path) = (self.desktop(), path.to_owned());
            blocking(move || {
                let target = match editor {
                    None => OpenTarget::FileManager,
                    Some((id, name)) => OpenTarget::App {
                        name,
                        line_url_scheme: LINE_URL_SCHEMES
                            .iter()
                            .find(|(known, _)| *known == id)
                            .map(|(_, scheme)| *scheme),
                    },
                };
                desktop.open_in(target, &path, line, column)
            })
            .await
            .unwrap_or(Err(eos_platform::Error::Unsupported("open in")))
            .map_err(failed)
        })
    }

    fn installed_editors(&self) -> Vec<Editor> {
        let desktop = self.desktop();
        EDITOR_APPS
            .iter()
            .filter(|(_, name)| desktop.app_installed(name))
            .map(|(id, name)| Editor { id, name })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use eos_core::SystemClock;

    use super::*;

    #[test]
    fn a_bundle_id_becomes_a_safe_file_name() {
        assert_eq!(sanitize_bundle_id("com.apple.TextEdit"), "com.apple.TextEdit");
        assert_eq!(sanitize_bundle_id("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_bundle_id(&"x".repeat(300)).len(), 200);
    }

    // The generic host has no desktop: every lookup reads as "none" and every
    // open is refused, without anything appearing on the user's screen.
    #[tokio::test]
    async fn a_system_without_a_desktop_answers_nothing_and_opens_nothing() {
        let dir = tempfile::tempdir().expect("dir");
        let apps = DesktopApps::new(eos_platform::generic_host(), Arc::new(SystemClock), dir.path().join("icons"));
        assert_eq!(apps.resolve_default_app(None, Some("txt")).await, None);
        assert_eq!(apps.resolve_default_app(Some("/no/such/file.md"), None).await, None);
        assert_eq!(apps.resolve_default_app(Some("/no/such/file"), None).await, None);
        assert_eq!(apps.icon_path_for_bundle_id("com.example.app").await, None);
        assert!(apps.installed_editors().is_empty());
        assert!(apps.open_path("/tmp").await.is_err());
        assert!(apps.reveal_path(Path::new("/tmp")).await.is_err());
        assert!(apps.open_in(OpenIn::Editor("vscode"), Path::new("/tmp"), Some(3), None).await.is_err());
        let unknown = apps.open_in(OpenIn::Editor("notepad"), Path::new("/tmp"), None, None).await;
        assert_eq!(unknown, Err(Error::Validation("unknown editor: notepad".into())));
        assert!(dir.path().join("icons").is_dir());
    }

    #[tokio::test]
    async fn an_icon_already_drawn_is_served_from_the_cache_folder() {
        let dir = tempfile::tempdir().expect("dir");
        let apps = DesktopApps::new(eos_platform::generic_host(), Arc::new(SystemClock), dir.path());
        fs::write(dir.path().join("com.example.app.png"), b"png").expect("write");
        assert_eq!(apps.icon_path_for_bundle_id("com.example.app").await, Some(dir.path().join("com.example.app.png")));
    }
}
