use std::path::{Path, PathBuf};

use crate::{BoxFuture, Error};

/// The app that opens a kind of file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    pub bundle_path: String,
    pub bundle_id: String,
    pub app_name: String,
}

/// An installed code editor: its id in the contract's list and its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
}

/// Where "open in" sends a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenIn<'a> {
    /// Shown selected in the file manager.
    FileManager,
    /// An editor by its contract id (`vscode`, `cursor`, …).
    Editor(&'a str),
}

/// Handing files to the rest of the desktop: other apps, the file manager.
/// Everything here acts on the user's screen, so only the user's own
/// dashboard may reach the methods that open something.
pub trait DesktopFiles: Send + Sync {
    /// The default app for a file, or for an extension when the file is not there.
    fn resolve_default_app<'a>(&'a self, path: Option<&'a str>, ext: Option<&'a str>)
    -> BoxFuture<'a, Option<AppInfo>>;
    /// A PNG of the app's icon, for an app [`resolve_default_app`](Self::resolve_default_app)
    /// has answered with before.
    fn icon_path_for_bundle_id<'a>(&'a self, bundle_id: &'a str) -> BoxFuture<'a, Option<PathBuf>>;
    /// Opens a path, or an `http(s)` URL, with its default app.
    fn open_path<'a>(&'a self, target: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    fn reveal_path<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), Error>>;
    /// An editor opens the file at `line` when it can.
    fn open_in<'a>(
        &'a self,
        target: OpenIn<'a>,
        path: &'a Path,
        line: Option<u32>,
        column: Option<u32>,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// The editors installed here, in the contract's order.
    fn installed_editors(&self) -> Vec<Editor>;
}
