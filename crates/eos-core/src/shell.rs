//! What the core may ask of the window shell: embedded Chromium views, screenshots, the
//! open panel and this computer's position.
//!
//! The shell implements these on its own threads; every method returns at once and resolves
//! later, so a caller never blocks the window.

use serde_json::Value;

use crate::BoxFuture;

/// One embedded view, named by the shell when it is created.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ViewId(pub String);

impl ViewId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ViewId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A rectangle in the main window, in logical pixels from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn is_empty(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }
}

/// A profile whose name starts with this is not kept: the shell removes its storage at the
/// next launch.
pub const THROWAWAY_PROFILE: &str = "tmp-";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewSpec {
    /// Names the storage (cookies, cache, local storage) the view uses. Views with the same
    /// profile share it; no view shares the dashboard's. See [`THROWAWAY_PROFILE`].
    pub profile: String,
    /// First page; `None` leaves the view on a blank page.
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ViewEvent {
    /// A DevTools protocol event of the view (`Page.frameNavigated`, …).
    Cdp { method: String, params: Value },
    /// The view asked for a new window (`window.open`, a `target=_blank` link). The shell
    /// opened nothing.
    OpenRequested { url: String },
    /// The view is gone: closed, or its renderer died.
    Closed,
}

/// Receives the events of every view. Called on a shell thread: return quickly.
pub trait ViewListener: Send + Sync {
    fn on_view_event(&self, view: &ViewId, event: &ViewEvent);
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ViewError {
    #[error("unknown view: {0}")]
    UnknownView(ViewId),
    /// The DevTools call was answered with an error.
    #[error("{method}: {message}")]
    Cdp { method: String, message: String },
    #[error("{0}: no answer in time")]
    Timeout(String),
    /// The shell could not do it (window gone, native call failed).
    #[error("{0}")]
    Shell(String),
}

/// Child Chromium views inside the main window. A new view is parked: it runs and can be
/// driven, but is not on screen until it is placed.
pub trait BrowserViews: Send + Sync {
    fn create(&self, spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>>;

    fn close(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>>;

    /// Shows the view at `rect`, above every other view.
    fn place(&self, view: &ViewId, rect: Rect) -> BoxFuture<'_, Result<(), ViewError>>;

    /// Takes the view off screen. Its page keeps a real layout size and keeps running, so it
    /// can still be driven and captured.
    fn park(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>>;

    fn set_muted(&self, view: &ViewId, muted: bool) -> BoxFuture<'_, Result<(), ViewError>>;

    /// The user asked this view for a page on `host`. Pages are kept off the local network
    /// (a page must not make the system ask the user to let Eos find devices there); a
    /// view the user sends to a LAN address or a `.local` name may reach it, for as long
    /// as it stays on the local network. A no-op for a host on the public internet. Call
    /// it before the navigation, and only for what the user typed or picked: never for
    /// where a page takes itself.
    fn allow_local_network(&self, view: &ViewId, host: &str) -> BoxFuture<'_, Result<(), ViewError>>;

    /// One DevTools protocol call; resolves with its result object.
    fn cdp(&self, view: &ViewId, method: &str, params: Value) -> BoxFuture<'_, Result<Value, ViewError>>;

    /// Adds a listener for the events of every view, current and future.
    fn listen(&self, listener: std::sync::Arc<dyn ViewListener>);
}

/// Told when the dashboard shows another tab in its browser panel, so "the page the human
/// sees" stays exact. Called on a shell thread: return quickly.
pub trait PanelListener: Send + Sync {
    fn active_view_changed(&self, session: &str, view: &ViewId);
}

/// The dashboard's browser panel: the one place a view comes on screen for the user. The
/// dashboard reports the panel's rectangle and which tab it shows; the shell places that
/// view there and parks the others.
pub trait BrowserPanel: Send + Sync {
    /// The view was closed: it is no longer the panel's.
    fn forget(&self, view: &ViewId);

    /// The view emulates a device of this size (CSS pixels): shown, it is centered in the
    /// panel at that size, clamped to the panel. `None`: it fills the panel.
    fn set_device_size(&self, view: &ViewId, size: Option<(f64, f64)>);

    /// The one listener told which tab the panel shows.
    fn listen(&self, listener: std::sync::Arc<dyn PanelListener>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureTarget {
    /// The dashboard itself.
    Dashboard,
    View(ViewId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg { quality: u8 },
}

impl ImageFormat {
    pub fn mime(&self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg { .. } => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub format: ImageFormat,
    pub bytes: Vec<u8>,
}

/// Screenshots of what a view currently shows, parked views included.
pub trait Capture: Send + Sync {
    fn capture(&self, target: CaptureTarget, format: ImageFormat) -> BoxFuture<'_, Result<Image, ViewError>>;
}

/// The native open panel, for a caller that needs the user to pick something on this Mac.
/// `None` means the user cancelled.
pub trait FilePicker: Send + Sync {
    fn pick_directory(&self) -> BoxFuture<'_, Option<String>>;
    fn pick_files(&self) -> BoxFuture<'_, Option<Vec<String>>>;
}

/// One reading of the system's location service.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PositionFix {
    pub lat: f64,
    pub lon: f64,
    /// Metres.
    pub accuracy: f64,
    /// When the system took it, in epoch milliseconds.
    pub at: i64,
}

/// Why the system gave no position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PositionError {
    /// The user refused Eos location access (or a policy restricts it).
    #[error("location access denied")]
    Denied,
    /// Location services are off for the whole computer.
    #[error("location services are off")]
    Disabled,
    /// No fix could be worked out right now.
    #[error("no location fix")]
    Unavailable,
    /// The system did not answer in time (a permission prompt may be open).
    #[error("no location in time")]
    Timeout,
    /// This build or system has no way to ask.
    #[error("location is not supported here")]
    Unsupported,
}

/// This computer's position. Asking may show the system's permission prompt
/// once, so it can take as long as the user takes to answer it.
pub trait Location: Send + Sync {
    fn current(&self) -> BoxFuture<'_, Result<PositionFix, PositionError>>;
}
