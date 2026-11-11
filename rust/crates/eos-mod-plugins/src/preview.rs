//! A picture of one plugin surface, drawn by the window shell in a hidden
//! window of its own — the user's windows and stored values are never
//! touched. For the agent writing the plugin: it gets the path of a PNG.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use eos_contracts::{PluginPreviewRequest, PluginPreviewSurface, PluginState};
use eos_core::plugin::{PluginPreviewCall, PluginPreviewFiles, PluginPreviewed, PluginPreviewer};
use eos_core::{BoxFuture, Clock, Error};

use crate::service::PluginService;

/// Why no picture was drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewFailure {
    /// The plugin is unknown, or drawing or saving failed.
    Failed(Error),
    /// The plugin is in no state to be drawn (off, broken, without a UI).
    NotDrawable(String),
    /// There is no window shell to draw with.
    NoWindow,
}

impl PreviewFailure {
    pub const NO_WINDOW: &str = "the Eos app isn't open, so nothing can draw the preview";
}

impl From<Error> for PreviewFailure {
    fn from(e: Error) -> Self {
        PreviewFailure::Failed(e)
    }
}

/// For a caller that only tells failures apart by their text (an agent tool).
impl From<PreviewFailure> for Error {
    fn from(failure: PreviewFailure) -> Self {
        match failure {
            PreviewFailure::Failed(e) => e,
            PreviewFailure::NotDrawable(why) => Error::Conflict(why),
            PreviewFailure::NoWindow => Error::Conflict(PreviewFailure::NO_WINDOW.to_owned()),
        }
    }
}

/// A shell that cannot draw: what the app is composed with until its window
/// shell implements [`PluginPreviewer`].
#[derive(Debug, Default, Clone, Copy)]
pub struct NoPreviewWindow;

impl PluginPreviewer for NoPreviewWindow {
    fn is_available(&self) -> bool {
        false
    }

    fn preview(&self, _call: PluginPreviewCall) -> BoxFuture<'_, Result<eos_contracts::PluginPreviewResult, Error>> {
        Box::pin(std::future::ready(Err(Error::Conflict(PreviewFailure::NO_WINDOW.to_owned()))))
    }
}

pub struct PluginPreviews {
    plugins: Arc<PluginService>,
    previewer: Arc<dyn PluginPreviewer>,
    files: Arc<dyn PluginPreviewFiles>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for PluginPreviews {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginPreviews").finish_non_exhaustive()
    }
}

fn surface_name(surface: PluginPreviewSurface) -> &'static str {
    match surface {
        PluginPreviewSurface::Main => "main",
        PluginPreviewSurface::Panel => "panel",
        PluginPreviewSurface::Header => "header",
    }
}

impl PluginPreviews {
    pub fn new(
        plugins: Arc<PluginService>,
        previewer: Arc<dyn PluginPreviewer>,
        files: Arc<dyn PluginPreviewFiles>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { plugins, previewer, files, clock }
    }

    /// Draws the plugin's current build once a pending rebuild has settled.
    pub async fn draw(&self, id: &str, request: PluginPreviewRequest) -> Result<PluginPreviewed, PreviewFailure> {
        self.plugins.settled(id).await;
        let plugin = self.plugins.get(id)?;
        if plugin.state != PluginState::Active || !plugin.has_ui || plugin.rev < 1 {
            let why = match plugin.state {
                PluginState::Disabled => "it is turned off in Settings › Plugins".to_owned(),
                PluginState::Error => {
                    format!("its build failed: {}", plugin.error.as_deref().unwrap_or("unknown error"))
                }
                PluginState::Active => "it has no UI entry".to_owned(),
            };
            return Err(PreviewFailure::NotDrawable(format!("can't preview \"{id}\": {why}")));
        }
        if !self.previewer.is_available() {
            return Err(PreviewFailure::NoWindow);
        }
        let build = plugin.rev;
        let shot = self.previewer.preview(PluginPreviewCall { request, plugin }).await?;
        let png = STANDARD
            .decode(shot.png.trim())
            .map_err(|e| Error::Storage(format!("the preview is not a picture: {e}")))?;
        // The tool channel is text-only: the picture goes to a file the agent reads.
        let (files, stem) =
            (self.files.clone(), format!("{id}-{}-{}", surface_name(shot.surface), self.clock.now_ms()));
        let path = tokio::task::spawn_blocking(move || files.save(&stem, &png)).await.map_err(Error::storage)??;
        Ok(PluginPreviewed {
            path: path.to_string_lossy().into_owned(),
            build,
            surface: shot.surface,
            view: shot.view,
            width: shot.width,
            height: shot.height,
            errors: shot.errors,
            available: shot.available,
        })
    }
}
