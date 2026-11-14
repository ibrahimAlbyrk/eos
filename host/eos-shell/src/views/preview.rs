//! Draws one surface of a plugin's build for the `plugin_preview` tool, off screen.
//!
//! No off-screen rendering mode is needed: a view of the main window that is hidden keeps a
//! real size and keeps painting, and DevTools captures it. The preview is such a view on the
//! dashboard's own profile, so it loads the dashboard's bundle from the app's origin with the
//! real styles and fonts (`index.html#plugin-preview` draws only the plugin), is never put on
//! screen, and is closed as soon as the picture is taken.

use std::sync::Arc;
use std::time::Duration;

use eos_bridge::urlspace::APP_HOST;
use eos_contracts::{PluginPreviewResult, PluginPreviewSurface, plugin_preview_size};
use eos_core::plugin::{PluginPreviewCall, PluginPreviewer};
use eos_core::shell::ViewError;
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};
use tauri::LogicalSize;

use super::{Cdp, View, Views, create, shell_error};

/// Under the 30 s a DevTools call may take, as the tool's caller expects an answer.
const TIMEOUT: Duration = Duration::from_secs(25);
/// How long the preview page may take to appear.
const PAGE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Previewer {
    views: Arc<Views>,
    /// One at a time: each preview is a whole renderer.
    queue: tokio::sync::Mutex<()>,
}

fn failed(message: impl Into<String>) -> Error {
    Error::Storage(message.into())
}

impl From<ViewError> for PreviewError {
    fn from(error: ViewError) -> Self {
        PreviewError(error.to_string())
    }
}

struct PreviewError(String);

/// The value of an evaluation, or what the page threw.
fn evaluated(answer: &Value) -> Result<Value, PreviewError> {
    if let Some(details) = answer.get("exceptionDetails") {
        let text = details.pointer("/exception/description").or_else(|| details.get("text")).and_then(Value::as_str);
        return Err(PreviewError(text.unwrap_or("the preview page failed").to_owned()));
    }
    Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

impl Previewer {
    pub(crate) fn new(views: Arc<Views>) -> Self {
        Previewer { views, queue: tokio::sync::Mutex::new(()) }
    }

    async fn evaluate(view: &View, expression: &str) -> Result<Value, PreviewError> {
        let params = json!({ "expression": expression, "awaitPromise": true, "returnByValue": true });
        evaluated(&view.cdp.call("Runtime.evaluate", params).await?)
    }

    async fn resize(&self, view: &Arc<View>, size: (f64, f64)) -> Result<(), PreviewError> {
        let view = view.clone();
        let resized = tokio::task::spawn_blocking(move || {
            view.webview.set_size(LogicalSize::new(size.0, size.1)).map_err(shell_error)
        });
        Ok(resized.await.map_err(shell_error)??)
    }

    async fn draw(
        &self,
        view: &Arc<View>,
        call: &PluginPreviewCall,
        size: (f64, f64),
    ) -> Result<PluginPreviewResult, PreviewError> {
        // A hidden view's page is otherwise treated as in the background: its animation
        // frames stop, and the preview page waits for two of them before it answers.
        view.cdp.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await?;
        let url = tauri::Url::parse(&format!("http://{APP_HOST}/index.html#plugin-preview")).map_err(shell_error)?;
        view.webview.navigate(url).map_err(shell_error)?;
        // The view starts on a blank page: wait until the preview page is the one answering.
        let started = std::time::Instant::now();
        loop {
            let at = Self::evaluate(view, "location.host + location.hash").await.unwrap_or(Value::Null);
            if at.as_str() == Some(&format!("{APP_HOST}#plugin-preview")) {
                break;
            }
            if started.elapsed() > PAGE_TIMEOUT {
                return Err(PreviewError("the preview page did not load".into()));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut args = serde_json::to_value(call).map_err(shell_error)?;
        let sizes = |surface| {
            let (width, height) = plugin_preview_size(surface);
            json!([width, height])
        };
        args["sizes"] = json!({
            "main": sizes(PluginPreviewSurface::Main),
            "panel": sizes(PluginPreviewSurface::Panel),
            "header": sizes(PluginPreviewSurface::Header),
        });
        let expression = format!(
            "(async () => {{
              for (let i = 0; i < 300 && !window.__eosPluginPreview; i++) await new Promise((r) => setTimeout(r, 50));
              if (!window.__eosPluginPreview) throw new Error(\"the preview page did not start\");
              return window.__eosPluginPreview({args});
            }})()"
        );
        let mut drawn = Self::evaluate(view, &expression).await?;
        // The surface's size is known once the page has seen what the plugin registered.
        let side = |key: &str| drawn.get(key).and_then(Value::as_f64).filter(|v| *v >= 1.0);
        if let (Some(width), Some(height)) = (side("width"), side("height"))
            && (width, height) != size
        {
            self.resize(view, (width, height)).await?;
            Self::evaluate(view, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))").await?;
        }
        let shot = view.cdp.call("Page.captureScreenshot", json!({ "format": "png" })).await?;
        let png = shot.get("data").and_then(Value::as_str).filter(|data| !data.is_empty());
        let png = png.ok_or_else(|| PreviewError("the preview window drew nothing".into()))?;
        drawn["png"] = json!(png);
        serde_json::from_value(drawn)
            .map_err(|e| PreviewError(format!("the preview page answered something else: {e}")))
    }
}

impl PluginPreviewer for Previewer {
    fn is_available(&self) -> bool {
        self.views.dashboard().is_some()
    }

    fn preview(&self, call: PluginPreviewCall) -> BoxFuture<'_, Result<PluginPreviewResult, Error>> {
        Box::pin(async move {
            let _one_at_a_time = self.queue.lock().await;
            let (width, height) = plugin_preview_size(call.request.surface.unwrap_or(PluginPreviewSurface::Main));
            let size = (
                call.request.width.map_or(width as f64, |w| w as f64),
                call.request.height.map_or(height as f64, |h| h as f64),
            );
            let views = self.views.clone();
            let view = tokio::task::spawn_blocking(move || views.create_app_view(size))
                .await
                .map_err(Error::storage)?
                .map_err(Error::storage)?;
            let drawn = tokio::time::timeout(TIMEOUT, self.draw(&view, &call, size)).await;
            // Whatever happened, the view does not outlive the call.
            let _ = tokio::task::spawn_blocking(move || view.webview.close()).await;
            match drawn {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(PreviewError(message))) => Err(failed(message)),
                Err(_) => Err(failed("the preview took too long to draw")),
            }
        })
    }
}

impl Views {
    /// A hidden view of `size` on the dashboard's own profile, for the app's own pages. It
    /// may only show the app's origin and is never one of the browser's tabs. Blocking.
    fn create_app_view(&self, size: (f64, f64)) -> Result<Arc<View>, ViewError> {
        let n = self.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let policy = create::Policy {
            navigation: Box::new(|url| {
                (url.scheme() == "http" && url.host_str() == Some(APP_HOST)) || url.as_str() == "about:blank"
            }),
            open_requested: Box::new(|_| {}),
        };
        let builder = create::builder(&format!("app-{n:04x}"), (0.0, 0.0), size, None, policy);
        let webview = self.window.add_child(builder).map_err(shell_error)?;
        let cdp = Cdp::attach(&webview, |_method, _params| {})?;
        let view = View::new(webview, cdp, false, String::new());
        view.webview.hide().map_err(shell_error)?;
        Ok(view)
    }
}
