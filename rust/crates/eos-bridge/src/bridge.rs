//! The one door: every request of the app's own origin arrives here and goes to the core's
//! router, a shell bridge or the dashboard bundle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use base64::Engine;
use eos_core::browser::ElementPicker;
use eos_core::shell::{Capture, CaptureTarget, ImageFormat, Rect, ViewId};
use serde_json::{Value, json};

use crate::assets::{Assets, Response};
use crate::core::{Core, Plane};
use crate::events::Events;
use crate::host::{Banner, BannerTarget, EditCommand, ShellHost, Theme};
use crate::migrate::{Marker, Seed};
use crate::panel::{Flag, Panel};
use crate::transport::{Req, Service, Sink};
use crate::urlspace::{self, Route};
use crate::{script, token};

/// What the bridge is built from.
pub struct Parts {
    /// The built dashboard (`app/ui/dist`).
    pub assets: PathBuf,
    /// The shell's own data folder (theme, one-time markers).
    pub data_dir: PathBuf,
    pub core: Arc<dyn Core>,
    pub host: Arc<dyn ShellHost>,
    /// The browser panel's geometry. Made before the core, which holds it too.
    pub panel: Panel,
    pub capture: Arc<dyn Capture>,
    pub rt: tokio::runtime::Handle,
    /// The `localStorage` carry-over for this launch (see `migrate::plan`).
    pub seed: Option<Seed>,
    /// Milliseconds since the Unix epoch, for the markers.
    pub now_ms: fn() -> u64,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").field("assets", &self.assets).field("data_dir", &self.data_dir).finish_non_exhaustive()
    }
}

/// What became of a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notified {
    Shown,
    /// The window has focus: the user is looking at the app, no banner.
    Suppressed,
    /// Not a notification (no title or body).
    Invalid,
}

#[derive(Debug, Default)]
struct Counters {
    requests: AtomicU64,
    core: AtomicU64,
    shell: AtomicU64,
    refused: AtomicU64,
}

pub struct Bridge {
    me: std::sync::Weak<Bridge>,
    assets: Assets,
    data_dir: PathBuf,
    core: Arc<dyn Core>,
    host: Arc<dyn ShellHost>,
    capture: Arc<dyn Capture>,
    rt: tokio::runtime::Handle,
    seed: Mutex<Option<Seed>>,
    now_ms: fn() -> u64,
    events: Events,
    panel: Panel,
    /// The browser feature's element picker, once the core is up.
    element_picker: OnceLock<Arc<dyn ElementPicker>>,
    started: Instant,
    ready_ms: Mutex<Option<(u64, u64)>>,
    counters: Counters,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bridge").field("assets", &self.assets).finish_non_exhaustive()
    }
}

fn json_response(status: u16, body: Value) -> Response {
    Response::new(status, "application/json", body.to_string()).with("cache-control", "no-store")
}

fn send(sink: &Sink, response: Response) {
    sink.respond(response.status, response.headers, &response.body);
}

/// A bridge call that cannot be done.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Refusal(u16, &'static str);

type Outcome = Result<Value, Refusal>;

impl Bridge {
    pub fn new(parts: Parts) -> Arc<Self> {
        Arc::new_cyclic(|me| Bridge {
            me: me.clone(),
            assets: Assets::new(parts.assets),
            data_dir: parts.data_dir,
            core: parts.core,
            host: parts.host,
            capture: parts.capture,
            rt: parts.rt,
            seed: Mutex::new(parts.seed),
            now_ms: parts.now_ms,
            events: Events::default(),
            panel: parts.panel,
            element_picker: OnceLock::new(),
            started: Instant::now(),
            ready_ms: Mutex::new(None),
            counters: Counters::default(),
        })
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    pub fn panel(&self) -> &Panel {
        &self.panel
    }

    /// Gives the panel its "pick an element" mode. Without one a pick answers nothing.
    pub fn set_element_picker(&self, picker: Arc<dyn ElementPicker>) {
        let _ = self.element_picker.set(picker);
    }

    // ---- shell → page ---------------------------------------------------------

    /// Shows a notification as a native banner, unless the user is looking at the app.
    /// `payload` is the wire shape: `{title, body, workerId?, route?}`.
    pub fn notify(&self, payload: &Value) -> Notified {
        let (Some(title), Some(body)) =
            (payload.get("title").and_then(Value::as_str), payload.get("body").and_then(Value::as_str))
        else {
            return Notified::Invalid;
        };
        if self.host.window_focused() {
            return Notified::Suppressed;
        }
        let text = |key: &str| payload.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        // A named view wins over a worker, as in the Electron shell.
        let target = text("route").map(BannerTarget::Route).or_else(|| text("workerId").map(BannerTarget::Worker));
        self.host.show_banner(Banner { title: title.to_string(), body: body.to_string(), target });
        Notified::Shown
    }

    /// The user clicked a banner: the dashboard opens what it was about.
    pub fn banner_clicked(&self, target: &BannerTarget) {
        let payload = match target {
            BannerTarget::Worker(id) => json!({ "workerId": id }),
            BannerTarget::Route(route) => json!({ "route": route }),
        };
        self.events.emit_or_wait("navigate", payload);
    }

    /// An Edit-menu command while the dashboard has the focus: the page decides what it
    /// means (composer stack, terminal, or the native command).
    pub fn edit(&self, command: EditCommand) {
        self.events.emit("edit", json!({ "command": command.name() }));
    }

    pub fn fullscreen_changed(&self, on: bool) {
        self.events.emit("window:fullscreen", json!({ "on": on }));
    }

    /// A shell command for the machine switcher (`connect`), optionally with the invite
    /// link that started it.
    pub fn hosts_command(&self, kind: &str, invite: Option<&str>) {
        self.events.emit_or_wait("hosts:command", json!({ "type": kind, "invite": invite }));
    }

    /// The theme the dashboard last switched to, for the window's first paint.
    pub fn persisted_theme(data_dir: &Path) -> Theme {
        std::fs::read_to_string(data_dir.join("theme.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v.get("theme").and_then(Value::as_str).map(Theme::parse))
            .unwrap_or(Theme::Dark)
    }

    /// For diagnostics and the smoke run: no user data.
    pub fn status(&self) -> Value {
        let panel = self.panel.status();
        let ready = *self.ready_ms.lock().unwrap_or_else(|p| p.into_inner());
        json!({
            "ready": ready.is_some(),
            "readyAfterLaunchMs": ready.map(|(since_launch, _)| since_launch),
            "readyInPageMs": ready.map(|(_, in_page)| in_page),
            "eventStreams": self.events.subscribers(),
            "core": self.core.status(),
            "requests": {
                "all": self.counters.requests.load(Ordering::Relaxed),
                "core": self.counters.core.load(Ordering::Relaxed),
                "shell": self.counters.shell.load(Ordering::Relaxed),
                "refused": self.counters.refused.load(Ordering::Relaxed),
            },
            "panel": {
                "view": panel.current.map(|v| v.0),
                "session": panel.session,
                "shown": panel.shown,
                "bounds": [panel.bounds.x, panel.bounds.y, panel.bounds.width, panel.bounds.height],
                "dropped": panel.dropped,
                "applied": panel.applied,
            },
        })
    }

    // ---- page → shell ---------------------------------------------------------

    fn entry_script(&self) -> String {
        let seed = self.seed.lock().unwrap_or_else(|p| p.into_inner());
        script::entry_script(&self.core.ui_token(), seed.as_ref().map(|s| &s.keys))
    }

    fn refuse(&self, sink: &Sink, status: u16, error: &str) {
        self.counters.refused.fetch_add(1, Ordering::Relaxed);
        send(sink, json_response(status, json!({ "error": error })));
    }

    fn shell(&self, path: &str, query: &str, req: Req, sink: Sink) {
        self.counters.shell.fetch_add(1, Ordering::Relaxed);
        let ui_token = self.core.ui_token();
        match (req.method.as_str(), path) {
            ("GET", "ping") => return send(&sink, Response::new(200, "text/plain", "ok")),
            // An `EventSource` cannot set a header: the token rides the query.
            ("GET", "events") => {
                return if token::is_from_dashboard(&req)
                    && token::matches(&ui_token, urlspace::query_param(query, "t").as_deref())
                {
                    self.events.subscribe(sink)
                } else {
                    self.refuse(&sink, 403, "ui token required")
                };
            }
            ("POST", _) => {}
            _ => return self.refuse(&sink, 405, "method not allowed"),
        }
        // Everything else acts on this Mac: the dashboard itself only.
        if !token::is_from_dashboard(&req) || !token::authorized(&ui_token, &req) {
            return self.refuse(&sink, 403, "ui token required");
        }
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let Some(me) = self.me.upgrade() else { return };
        let path = path.to_string();
        // Off the request thread: bridges reach into the window and the views.
        self.rt.spawn(async move {
            let outcome = me.bridge(&path, body).await;
            match outcome {
                Ok(value) => send(&sink, json_response(200, json!({ "value": value }))),
                Err(Refusal(status, error)) => me.refuse(&sink, status, error),
            }
        });
    }

    async fn bridge(&self, path: &str, body: Value) -> Outcome {
        let seq = body.get("seq").and_then(Value::as_u64).unwrap_or(0);
        let flag = body.get("value").and_then(Value::as_bool).unwrap_or(false);
        let text = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        match path {
            "ready" => {
                let in_page = body.get("ms").and_then(Value::as_u64).unwrap_or(0);
                let mut ready = self.ready_ms.lock().unwrap_or_else(|p| p.into_inner());
                ready.get_or_insert((self.started.elapsed().as_millis() as u64, in_page));
                Ok(Value::Null)
            }
            "migration/done" => {
                let seed = self.seed.lock().unwrap_or_else(|p| p.into_inner()).take();
                if seed.is_some() {
                    let keys = body.get("keys").and_then(Value::as_u64).unwrap_or(0) as usize;
                    Marker::new(&self.data_dir)
                        .write((self.now_ms)(), keys, None)
                        .map_err(|_| Refusal(500, "marker not written"))?;
                }
                Ok(Value::Null)
            }

            // ---- window
            "window/startDragging" => self.blocking(|host| host.start_window_drag()).await,
            "window/toggleZoom" => self.blocking(|host| host.toggle_window_zoom()).await,

            // ---- notifications
            "notify" => Ok(json!(matches!(self.notify(&body), Notified::Shown))),

            // ---- theme
            "theme/changed" => {
                let theme = Theme::parse(&text("theme"));
                let _ = std::fs::create_dir_all(&self.data_dir);
                let _ = std::fs::write(self.data_dir.join("theme.json"), json!({ "theme": theme.name() }).to_string());
                self.blocking(move |host| host.set_theme(theme)).await
            }
            "theme/snapshot" => {
                Ok(self.still(CaptureTarget::Dashboard, 92).await.map(Value::String).unwrap_or(Value::Null))
            }

            // ---- files and the clipboard
            "files/save" => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(text("base64"))
                    .map_err(|_| Refusal(400, "bad base64"))?;
                let name = sanitize_filename(&text("filename"));
                self.blocking_value(move |host| {
                    let dest = host.downloads_dir().join(name);
                    if std::fs::write(&dest, bytes).is_ok() {
                        host.open_path(&dest);
                    }
                    Value::Null
                })
                .await
            }
            "files/dropped" => self.blocking_value(|host| entries(host.dropped_file_paths())).await,
            "clipboard/paths" => self.blocking_value(|host| entries(host.clipboard_file_paths())).await,
            "clipboard/read" => {
                self.blocking_value(
                    |host| json!({ "text": host.clipboard_text(), "hasFiles": host.clipboard_has_files() }),
                )
                .await
            }
            "clipboard/write" => {
                let value = text("text");
                self.blocking(move |host| host.set_clipboard_text(&value)).await
            }
            "edit" => {
                let command = EditCommand::parse(&text("command")).ok_or(Refusal(400, "unknown command"))?;
                self.blocking(move |host| host.edit(command)).await
            }

            // ---- the browser panel
            "browserView/setActiveView" => {
                let (session, tab) = (text("sessionKey"), text("tabId"));
                if tab.is_empty() {
                    return Err(Refusal(400, "tabId required"));
                }
                self.panel.set_active(seq, &session, ViewId(tab));
                Ok(Value::Null)
            }
            "browserView/setBounds" => {
                let n = |key: &str| body.get(key).and_then(Value::as_f64);
                let (Some(x), Some(y), Some(width), Some(height)) = (n("x"), n("y"), n("width"), n("height")) else {
                    return Err(Refusal(400, "x, y, width and height required"));
                };
                self.panel.set_bounds(seq, Rect { x, y, width, height });
                Ok(Value::Null)
            }
            "browserView/setVisible" => Ok(self.flag(seq, Flag::Visible, flag)),
            "browserView/overlay" => Ok(self.flag(seq, Flag::Overlay, flag)),
            "browserView/occluded" => Ok(self.flag(seq, Flag::Occluded, flag)),
            // A still of the view on screen, to stand in for it under a DOM layer.
            "browserView/snapshot" => {
                let Some((view, rect)) = self.panel.shown() else { return Ok(Value::Null) };
                Ok(match self.still(CaptureTarget::View(view), 90).await {
                    Some(url) => {
                        json!({ "url": url, "rect": { "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height } })
                    }
                    None => Value::Null,
                })
            }
            // The user picks an element on the live view; the answer is the element, or
            // null when the pick was cancelled.
            "browserView/pick" => {
                let Some(picker) = self.element_picker.get() else { return Ok(Value::Null) };
                let picked = picker.pick(&text("tabId")).await;
                Ok(picked.and_then(|element| serde_json::to_value(element).ok()).unwrap_or(Value::Null))
            }
            "browserView/pickCancel" => {
                if let Some(picker) = self.element_picker.get() {
                    picker.cancel();
                }
                Ok(Value::Null)
            }

            // ---- the machine switcher: no other computers yet
            "hosts/list" => Ok(json!({ "hosts": [], "active": null, "local": null })),

            _ => Err(Refusal(404, "unknown bridge")),
        }
    }

    fn flag(&self, seq: u64, flag: Flag, value: bool) -> Value {
        self.panel.set_flag(seq, flag, value);
        Value::Null
    }

    async fn still(&self, target: CaptureTarget, quality: u8) -> Option<String> {
        let image = self.capture.capture(target, ImageFormat::Jpeg { quality }).await.ok()?;
        if image.bytes.is_empty() {
            return None;
        }
        Some(format!(
            "data:{};base64,{}",
            image.format.mime(),
            base64::engine::general_purpose::STANDARD.encode(image.bytes)
        ))
    }

    async fn blocking(&self, f: impl FnOnce(&dyn ShellHost) + Send + 'static) -> Outcome {
        self.blocking_value(move |host| {
            f(host);
            Value::Null
        })
        .await
    }

    async fn blocking_value(&self, f: impl FnOnce(&dyn ShellHost) -> Value + Send + 'static) -> Outcome {
        let host = self.host.clone();
        self.rt.spawn_blocking(move || f(host.as_ref())).await.map_err(|_| Refusal(500, "bridge failed"))
    }
}

impl Service for Bridge {
    fn call(&self, mut req: Req, sink: Sink) {
        self.counters.requests.fetch_add(1, Ordering::Relaxed);
        match urlspace::route(&req.url) {
            Route::Core(target) => {
                self.counters.core.fetch_add(1, Ordering::Relaxed);
                if token::wants_media_token(&target, &req) || token::wants_dialog_token(&target, &req) {
                    req.set_header(token::TOKEN_HEADER, &self.core.ui_token());
                }
                req.url = target;
                self.core.call(Plane::Api, req, sink);
            }
            Route::Plugin(target) => {
                if req.method != "GET" {
                    return self.refuse(&sink, 405, "method not allowed");
                }
                self.counters.core.fetch_add(1, Ordering::Relaxed);
                req.url = target;
                self.core.call(Plane::Api, req, sink);
            }
            Route::Raw(target) => {
                self.counters.core.fetch_add(1, Ordering::Relaxed);
                req.url = target;
                self.core.call(Plane::Raw, req, sink);
            }
            Route::Shell { path, query } => self.shell(&path, &query, req, sink),
            Route::Asset(rel) => {
                // Only the dashboard's own top-level load gets the bridge script, which
                // holds the ui-token: a frame showing this document gets it as built.
                let script = token::is_top_level_document(&req).then(|| self.entry_script());
                let assets = self.assets.clone();
                self.rt.spawn_blocking(move || send(&sink, assets.serve(&rel, &req, script.as_deref())));
            }
            Route::Unknown => send(&sink, Response::not_found()),
        }
    }
}

/// The last path component, without separators: a download never leaves the folder.
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().map(|c| if matches!(c, '/' | '\\' | ':') { '_' } else { c }).collect();
    if clean.is_empty() || clean == "." || clean == ".." { "download".to_string() } else { clean }
}

/// `[{path, isDir}]`, the shape the dashboard takes for dropped and pasted files.
fn entries(paths: Vec<String>) -> Value {
    Value::Array(
        paths
            .into_iter()
            .filter(|p| !p.is_empty())
            .map(|p| {
                let is_dir = std::fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
                json!({ "path": p, "isDir": is_dir })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests;
