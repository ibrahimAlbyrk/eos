//! The door of one host's view: every request of the app's origins made in that view's
//! profile arrives here, never at the dashboard's [`crate::Bridge`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use base64::Engine;
use serde_json::{Value, json};

use super::Inner;
use crate::ask::{MAX_ANSWER, collect};
use crate::assets::{Assets, Response, inject_script};
use crate::bridge::save_download;
use crate::core::{Core, Plane};
use crate::events::Events;
use crate::host::{ShellHost, Theme};
use crate::script;
use crate::token::{self, TOKEN_HEADER};
use crate::transport::{Req, Service, Sink, channel};
use crate::urlspace::{self, APP_HOST, RAW_BASE, Route};

pub(crate) struct Parts {
    pub(crate) id: String,
    /// The token of `POST /api/hosts/<id>/view-token`: valid only under this host's prefix.
    pub(crate) view_token: String,
    /// What the page reads as `window.__EOS_HOST`.
    pub(crate) descriptor: Value,
    pub(crate) core: Arc<dyn Core>,
    pub(crate) dist: PathBuf,
    pub(crate) shell: Arc<dyn ShellHost>,
    pub(crate) manager: Weak<Inner>,
    pub(crate) rt: tokio::runtime::Handle,
}

pub struct HostViewService {
    me: Weak<HostViewService>,
    id: String,
    view_token: String,
    descriptor: Value,
    core: Arc<dyn Core>,
    assets: Assets,
    shell: Arc<dyn ShellHost>,
    pub(super) manager: Weak<Inner>,
    rt: tokio::runtime::Handle,
    events: Events,
    /// The page runs this computer's own dashboard (decided at each entry load). Only then
    /// does it get the transfer calls: a host-served bundle is that computer's code.
    ours: AtomicBool,
    /// The folder last picked here for this page: what "save to the folder I chose" means.
    pub(super) chosen: Mutex<Option<String>>,
}

impl std::fmt::Debug for HostViewService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostViewService").field("id", &self.id).finish_non_exhaustive()
    }
}

/// The content policy of a host's entry document: every fetch, frame and media load pinned
/// to that host's prefix on both origins.
pub fn host_content_security_policy(id: &str) -> String {
    let core = format!("http://{APP_HOST}/_core/h/{id}/");
    let raw = format!("{RAW_BASE}/h/{id}/");
    [
        "default-src 'self'".to_string(),
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'".into(),
        "style-src 'self' 'unsafe-inline'".into(),
        format!("img-src 'self' data: blob: {raw} https://img.logo.dev"),
        "font-src 'self' data:".into(),
        format!("connect-src {core} http://{APP_HOST}/_shell/"),
        format!("frame-src {raw}"),
        "worker-src 'self' blob:".into(),
        format!("media-src data: blob: {raw}"),
        "object-src 'none'".into(),
    ]
    .join("; ")
}

fn send(sink: &Sink, response: Response) {
    sink.respond(response.status, response.headers, &response.body);
}

fn refuse(sink: &Sink, status: u16, error: &str) {
    sink.respond(
        status,
        vec![("content-type".into(), "application/json".into())],
        json!({ "error": error }).to_string().as_bytes(),
    );
}

fn with_policy(mut response: Response, policy: &str) -> Response {
    response.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-security-policy"));
    response.with("content-security-policy", policy)
}

impl HostViewService {
    pub(crate) fn new(parts: Parts) -> Arc<Self> {
        Arc::new_cyclic(|me| HostViewService {
            me: me.clone(),
            id: parts.id,
            view_token: parts.view_token,
            descriptor: parts.descriptor,
            core: parts.core,
            assets: Assets::new(parts.dist),
            shell: parts.shell,
            manager: parts.manager,
            rt: parts.rt,
            events: Events::default(),
            ours: AtomicBool::new(true),
            chosen: Mutex::default(),
        })
    }

    pub fn host_id(&self) -> &str {
        &self.id
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    pub fn trusted(&self) -> bool {
        self.ours.load(Ordering::SeqCst)
    }

    fn prefix(&self) -> String {
        format!("/h/{}", self.id)
    }

    /// Whether `target` (origin-form) lies under this host's prefix.
    fn mine(&self, target: &str) -> bool {
        let path = target.split('?').next().unwrap_or("");
        let prefix = self.prefix();
        let inside = path == prefix || path.starts_with(&format!("{prefix}/"));
        inside && !path.split('/').any(|s| s == ".." || s == "." || s.eq_ignore_ascii_case("%2e%2e"))
    }

    fn entry_script(&self) -> String {
        let core = format!("{}{}", urlspace::CORE_BASE, self.prefix());
        let raw = format!("{RAW_BASE}{}", self.prefix());
        script::host_entry_script(&self.view_token, &core, &raw, &self.descriptor)
    }

    /// A request on to the core as this host's view: the view token, whatever the page sent.
    fn to_core(&self, plane: Plane, mut req: Req, target: String, sink: Sink) {
        req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(TOKEN_HEADER));
        req.set_header(TOKEN_HEADER, &self.view_token);
        req.url = target;
        self.core.call(plane, req, sink);
    }

    fn serve_asset(&self, rel: String, req: Req, sink: Sink) {
        let Some(me) = self.me.upgrade() else { return };
        self.rt.spawn(async move {
            let entry = rel.is_empty() || rel == "index.html";
            if entry {
                let ours = match me.manager.upgrade() {
                    Some(manager) => manager.runs_ours(&me.id, &me.view_token).await,
                    None => true,
                };
                me.ours.store(ours, Ordering::SeqCst);
            }
            let ours = me.trusted();
            let script = (entry && token::is_top_level_document(&req)).then(|| me.entry_script());
            let policy = host_content_security_policy(&me.id);
            // A fingerprinted asset this computer has is byte for byte the host's.
            if ours || rel.starts_with("assets/") {
                let assets = me.assets.clone();
                let (local_req, local_rel, local_script) = (req.clone(), rel.clone(), script.clone());
                let local =
                    tokio::task::spawn_blocking(move || assets.serve(&local_rel, &local_req, local_script.as_deref()))
                        .await
                        .unwrap_or_else(|_| Response::not_found());
                if local.status != 404 || ours {
                    return send(&sink, if entry { with_policy(local, &policy) } else { local });
                }
            }
            let target = format!("{}/ui/{}", me.prefix(), if rel.is_empty() { "index.html" } else { &rel });
            if !entry {
                return me.to_core(Plane::Api, req, target, sink);
            }
            // The host's own entry document gets the same bridge script and policy.
            let (host_sink, body) = channel();
            me.to_core(Plane::Api, Req { body: Vec::new(), ..req.clone() }, target, host_sink);
            let Some((head, bytes)) = collect(&body, MAX_ANSWER).await else {
                return send(&sink, Response::not_found());
            };
            if head.status != 200 {
                return send(&sink, Response::not_found());
            }
            let html = String::from_utf8_lossy(&bytes);
            let html = match &script {
                Some(script) => inject_script(&html, script),
                None => html.into_owned(),
            };
            send(
                &sink,
                Response::new(200, "text/html; charset=utf-8", html)
                    .with("content-security-policy", &policy)
                    .with("cache-control", "no-store"),
            );
        });
    }

    fn shell(&self, path: &str, query: &str, req: Req, sink: Sink) {
        match (req.method.as_str(), path) {
            ("GET", "events") => {
                return if token::is_from_dashboard(&req)
                    && token::matches(&self.view_token, urlspace::query_param(query, "t").as_deref())
                {
                    self.events.subscribe(sink)
                } else {
                    refuse(&sink, 403, "view token required")
                };
            }
            ("POST", _) => {}
            _ => return refuse(&sink, 405, "method not allowed"),
        }
        // The view's own document only, with its token.
        if !token::is_from_dashboard(&req) || !token::authorized(&self.view_token, &req) {
            return refuse(&sink, 403, "view token required");
        }
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let Some(me) = self.me.upgrade() else { return };
        let path = path.to_owned();
        self.rt.spawn(async move {
            let reply = match me.verb(&path, &body).await {
                Some(Ok(value)) => json!({ "value": value }),
                Some(Err((error, code))) => json!({ "error": error, "code": code }),
                None => return refuse(&sink, 404, "unknown bridge"),
            };
            sink.respond(200, vec![("content-type".into(), "application/json".into())], reply.to_string().as_bytes());
        });
    }

    async fn verb(&self, path: &str, body: &Value) -> Option<Result<Value, (String, Option<String>)>> {
        let manager = self.manager.upgrade()?;
        let views = super::HostViews { inner: manager };
        let id = || body.get("id").and_then(Value::as_str).map(str::to_owned);
        Some(Ok(match path {
            "hosts/list" => views.snapshot(),
            "hosts/switchTo" => {
                views.switch_to(id()).await;
                Value::Null
            }
            "hosts/openInWindow" => {
                if let Some(id) = id() {
                    views.open_in_window(id).await;
                }
                Value::Null
            }
            "hosts/reconnect" => {
                if let Some(id) = id() {
                    views.reconnect(id).await;
                }
                Value::Null
            }
            "hosts/requestConnect" => {
                views.request_connect().await;
                Value::Null
            }
            "window/startDragging" => {
                let shell = self.shell.clone();
                let _ = tokio::task::spawn_blocking(move || shell.start_window_drag()).await;
                Value::Null
            }
            "window/toggleZoom" => {
                let shell = self.shell.clone();
                let _ = tokio::task::spawn_blocking(move || shell.toggle_window_zoom()).await;
                Value::Null
            }
            // The window paints its background with the theme the page switched to; it is not
            // kept (this computer's dashboard keeps its own).
            "theme/changed" => {
                let (shell, theme) =
                    (self.shell.clone(), Theme::parse(body.get("theme").and_then(Value::as_str).unwrap_or("")));
                let _ = tokio::task::spawn_blocking(move || shell.set_theme(theme)).await;
                Value::Null
            }
            // No still of a host's view: the page switches its theme without the crossfade.
            "theme/snapshot" => Value::Null,
            // A download lands in this computer's Downloads: only from this computer's own
            // dashboard, never from a host-served bundle.
            "files/save" => {
                if !self.trusted() {
                    return Some(Err((
                        "Saving needs the same Eos version on both Macs.".to_owned(),
                        Some("needs-update".to_owned()),
                    )));
                }
                let text = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(text("base64")) else {
                    return Some(Err(("bad base64".to_owned(), None)));
                };
                let (shell, name) = (self.shell.clone(), text("filename"));
                let _ = tokio::task::spawn_blocking(move || save_download(shell.as_ref(), &name, &bytes)).await;
                Value::Null
            }
            transfer if transfer.starts_with("transfer/") => {
                return Some(super::transfers::call(self, &views, &transfer["transfer/".len()..], body).await);
            }
            _ => return None,
        }))
    }

    /// The other side of every transfer call: this host, never a value the page sends.
    pub(super) fn core(&self) -> &dyn Core {
        self.core.as_ref()
    }
}

impl Service for HostViewService {
    fn call(&self, req: Req, sink: Sink) {
        match urlspace::route(&req.url) {
            Route::Asset(rel) => self.serve_asset(rel, req, sink),
            Route::Core(target) if self.mine(&target) => self.to_core(Plane::Api, req, target, sink),
            Route::Raw(target) if self.mine(&target) => self.to_core(Plane::Raw, req, target, sink),
            // Plugins are the host's: its builds, through its prefix.
            Route::Plugin(target) if req.method == "GET" => {
                let target = format!("{}{target}", self.prefix());
                self.to_core(Plane::Api, req, target, sink);
            }
            Route::Shell { path, query } => self.shell(&path, &query, req, sink),
            Route::Core(_) | Route::Raw(_) | Route::Plugin(_) => refuse(&sink, 403, "outside this computer's view"),
            Route::Unknown => send(&sink, Response::not_found()),
        }
    }
}
