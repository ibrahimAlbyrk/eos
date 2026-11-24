//! The page probe and the page printer (05 Q3, Q9): a hidden view on the raw-content
//! origin that lays out a page design as the dashboard's frame would, measures it at each
//! width with Eos's measuring script and takes its picture; and one that prints a page
//! issue to a PDF with CEF's own `print_to_pdf` (DevTools' `Page.printToPDF` answers only
//! in a headless browser). Neither is put on screen; each is closed when its call ends.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use eos_bridge::urlspace::RAW_HOST;
use eos_core::surface::{PagePrinter, PageProbe, Paper, ProbeDoc, ProbeFinding, ProbeWidth};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};
use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::*;
use tokio::sync::oneshot;

use super::{View, Views};
use crate::catch::guarded;

/// A whole measure of one design at every width.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(45);
/// A whole print (05: PDF in 20 s).
const PRINT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a page may take to load.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
/// The height a page is laid out in before it is measured whole.
const VIEW_HEIGHT: u32 = 900;
/// The tallest picture taken: a longer page is cut there.
const SHOT_MAX_HEIGHT: f64 = 6000.0;

fn failed(message: impl Into<String>) -> Error {
    Error::Storage(message.into())
}

/// The value of an evaluation, or what the page threw.
fn evaluated(answer: &Value) -> Result<Value, Error> {
    if let Some(details) = answer.get("exceptionDetails") {
        let text = details.pointer("/exception/description").or_else(|| details.get("text")).and_then(Value::as_str);
        return Err(failed(text.unwrap_or("the measuring script failed").to_owned()));
    }
    Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

async fn evaluate(view: &View, expression: &str) -> Result<Value, Error> {
    let params = json!({ "expression": expression, "awaitPromise": true, "returnByValue": true });
    evaluated(&view.cdp.call("Runtime.evaluate", params).await.map_err(failed_view)?)
}

fn failed_view(error: eos_core::shell::ViewError) -> Error {
    failed(error.to_string())
}

/// Opens `url` and waits until it is the page answering, loaded with its fonts.
async fn open(view: &View, url: &str) -> Result<(), Error> {
    let target = tauri::Url::parse(url).map_err(|e| failed(e.to_string()))?;
    view.webview.navigate(target).map_err(|e| failed(e.to_string()))?;
    let started = Instant::now();
    let wanted = json!(url);
    loop {
        let at = evaluate(view, "document.readyState === 'complete' ? location.href : ''").await.unwrap_or(Value::Null);
        if at == wanted {
            break;
        }
        if started.elapsed() > LOAD_TIMEOUT {
            return Err(failed("the page did not load"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    evaluate(view, "document.fonts ? document.fonts.ready.then(() => true) : true").await?;
    Ok(())
}

/// What the measuring script answered: `{width, findings}`.
fn findings_of(measured: &Value) -> Vec<ProbeFinding> {
    serde_json::from_value(measured.get("findings").cloned().unwrap_or(Value::Null)).unwrap_or_default()
}

/// Lays `doc` out at `width`, measures it and writes its picture into `shots`.
async fn measure_at(view: &View, doc: &ProbeDoc, width: u16, shots: &Path) -> Result<ProbeWidth, Error> {
    let metrics = json!({ "width": width, "height": VIEW_HEIGHT, "deviceScaleFactor": 1, "mobile": false });
    view.cdp.call("Emulation.setDeviceMetricsOverride", metrics).await.map_err(failed_view)?;
    open(view, &doc.url).await?;
    let measured = evaluate(view, &doc.script).await?;
    let height = evaluate(view, "document.documentElement.scrollHeight").await?.as_f64().unwrap_or(VIEW_HEIGHT as f64);
    let clip = json!({ "x": 0, "y": 0, "width": width, "height": height.clamp(1.0, SHOT_MAX_HEIGHT), "scale": 1 });
    let shot = view
        .cdp
        .call("Page.captureScreenshot", json!({ "format": "png", "clip": clip, "captureBeyondViewport": true }))
        .await
        .map_err(failed_view)?;
    let screenshot = match shot.get("data").and_then(Value::as_str) {
        Some(data) if !data.is_empty() => {
            let png = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| failed(e.to_string()))?;
            std::fs::create_dir_all(shots).map_err(Error::storage)?;
            let path = shots.join(format!("{width}.png"));
            std::fs::write(&path, png).map_err(Error::storage)?;
            Some(path)
        }
        _ => None,
    };
    Ok(ProbeWidth { width, findings: findings_of(&measured), screenshot })
}

/// The probe and the printer share one queue: each call is a whole renderer.
pub(crate) struct PageViews {
    views: Arc<Views>,
    queue: tokio::sync::Mutex<()>,
}

impl PageViews {
    pub(crate) fn new(views: Arc<Views>) -> Self {
        PageViews { views, queue: tokio::sync::Mutex::new(()) }
    }

    /// Runs `work` on a fresh hidden view of the raw origin, closed afterwards whatever
    /// happened, within `limit`.
    async fn with_view<T>(
        &self,
        limit: Duration,
        work: impl AsyncFnOnce(&Arc<View>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _one_at_a_time = self.queue.lock().await;
        let views = self.views.clone();
        let size = (1000.0, VIEW_HEIGHT as f64);
        let view = tokio::task::spawn_blocking(move || views.create_hidden_view(size, RAW_HOST))
            .await
            .map_err(Error::storage)?
            .map_err(failed_view)?;
        // A hidden view's page is otherwise in the background: its fonts and frames wait.
        let focused = view.cdp.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await;
        let done = match focused {
            Ok(_) => {
                tokio::time::timeout(limit, work(&view)).await.unwrap_or_else(|_| Err(failed("the page took too long")))
            }
            Err(e) => Err(failed_view(e)),
        };
        crate::views::create::closed(view.webview.label());
        let _ = tokio::task::spawn_blocking(move || view.webview.close()).await;
        done
    }
}

impl PageProbe for PageViews {
    fn is_available(&self) -> bool {
        // The hidden views are children of the window, which exists while the shell does.
        true
    }

    fn measure<'a>(
        &'a self,
        doc: ProbeDoc,
        widths: &'a [u16],
        shots: &'a Path,
    ) -> BoxFuture<'a, Result<Vec<ProbeWidth>, Error>> {
        Box::pin(async move {
            self.with_view(MEASURE_TIMEOUT, async |view| {
                let mut out = Vec::with_capacity(widths.len());
                for width in widths {
                    out.push(measure_at(view, &doc, *width, shots).await?);
                }
                Ok(out)
            })
            .await
        })
    }
}

wrap_pdf_print_callback! {
    struct Printed {
        done: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    }

    impl PdfPrintCallback {
        fn on_pdf_print_finished(&self, _path: Option<&CefString>, ok: ::std::os::raw::c_int) {
            guarded("a PDF's end", || {
                if let Some(done) = self.done.lock().ok().and_then(|mut d| d.take()) {
                    let _ = done.send(ok != 0);
                }
            }, || ());
        }
    }
}

/// CEF's print settings for `paper`: backgrounds printed, `@page` sizes win.
fn settings(paper: Paper) -> PdfPrintSettings {
    let (width, height) = paper.inches();
    PdfPrintSettings {
        print_background: 1,
        paper_width: width,
        paper_height: height,
        prefer_css_page_size: 1,
        ..PdfPrintSettings::default()
    }
}

/// Prints the view's page to `out`; whether CEF wrote it.
async fn print(view: &View, paper: Paper, out: &Path) -> Result<bool, Error> {
    let (done, finished) = oneshot::channel();
    let path = out.to_string_lossy().into_owned();
    let done = Arc::new(Mutex::new(Some(done)));
    // On the browser's UI thread, where CEF also calls the callback.
    view.webview
        .with_cef_webview(move |w| {
            let Some(host) = w.browser().host() else { return };
            let mut callback = Printed::new(done);
            host.print_to_pdf(Some(&CefString::from(path.as_str())), Some(&settings(paper)), Some(&mut callback));
        })
        .map_err(|e| failed(e.to_string()))?;
    finished.await.map_err(|_| failed("the page could not be printed"))
}

impl PagePrinter for PageViews {
    fn is_available(&self) -> bool {
        true
    }

    fn pdf<'a>(&'a self, doc: ProbeDoc, paper: Paper, out: &'a Path) -> BoxFuture<'a, Result<u64, Error>> {
        Box::pin(async move {
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir).map_err(Error::storage)?;
            }
            self.with_view(PRINT_TIMEOUT, async |view| {
                open(view, &doc.url).await?;
                if !print(view, paper, out).await? {
                    return Err(failed("the page could not be printed"));
                }
                let bytes = std::fs::metadata(out).map_err(Error::storage)?.len();
                Ok(bytes)
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_measuring_script_answer_gives_its_findings() {
        let measured =
            json!({"width": 360, "findings": [{"check": "readable", "part": "lead", "detail": "text under 12 px"}]});
        assert_eq!(
            findings_of(&measured),
            vec![ProbeFinding {
                check: "readable".into(),
                part: Some("lead".into()),
                detail: "text under 12 px".into()
            }]
        );
        assert!(findings_of(&json!(null)).is_empty());
    }

    #[test]
    fn a_page_prints_on_its_paper_with_its_backgrounds() {
        let a4 = settings(Paper::A4);
        assert_eq!((a4.paper_width, a4.paper_height, a4.print_background), (8.27, 11.69, 1));
        assert_eq!(settings(Paper::Letter).paper_width, 8.5);
    }
}
