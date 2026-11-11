// Shell gate: the real Eos dashboard in a Tauri 3 (alpha) + CEF shell.
//
// One binary, configured by env (see run.sh), driven from outside through a file RPC
// (`$GATE_OUT/ctl/<n>.req` → `<n>.res`, see ctl.py) so a test can poke any view over the
// in-process DevTools channel without a debugging port.
#![allow(clippy::too_many_arguments)]

use std::{
  collections::HashMap,
  io::Write,
  path::PathBuf,
  sync::{Arc, Mutex, OnceLock, atomic::Ordering, mpsc},
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Url, WebviewUrl, webview::WebviewBuilder, window::WindowBuilder};
use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};
use tauri_runtime_cef::{Cef, SecretStorage, WebviewBuilderCefExt, WebviewCefExt};

mod appkit;
mod axtree;
mod browser;
mod cdp;
mod service;
mod transport;

use browser::{Browser, Park};
use cdp::Cdp;
use service::{APP_HOST, Cfg, GateService, RAW_HOST, Router};

static START: OnceLock<Instant> = OnceLock::new();
static LOG_FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

pub fn log(tag: &str, msg: &str) {
  let ms = START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0);
  let line = format!("[{ms:>7} ms] {tag}: {msg}\n");
  eprint!("{line}");
  if let Some(f) = LOG_FILE.get() {
    let _ = f.lock().unwrap().write_all(line.as_bytes());
  }
}

fn env(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|v| !v.is_empty())
}

struct Views {
  map: Mutex<HashMap<String, (tauri::Webview, Cdp)>>,
  nav_log: Mutex<Vec<Value>>,
}

struct Gate {
  app: tauri::AppHandle,
  window: tauri::Window,
  svc: Arc<GateService>,
  browser: Arc<Browser>,
  views: Views,
  out: PathBuf,
  window_number: isize,
  start_epoch_ms: u128,
}

#[tauri_runtime_cef::cef_entry_point]
fn main() {
  START.set(Instant::now()).ok();
  let start_epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let out = PathBuf::from(env("GATE_OUT").expect("GATE_OUT"));
  let _ = std::fs::create_dir_all(out.join("ctl"));
  if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(out.join("gate.log")) {
    LOG_FILE.set(Mutex::new(f)).ok();
  }
  let max_secs: u64 = env("GATE_MAX_SECS").and_then(|v| v.parse().ok()).unwrap_or(420);
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(max_secs));
    log("gate", "watchdog exit");
    std::process::exit(3);
  });

  let token = env("GATE_TOKEN_FILE").and_then(|f| std::fs::read_to_string(f).ok()).map(|s| s.trim().to_string()).unwrap_or_default();
  let cfg = Cfg {
    api_base: env("GATE_API").unwrap_or_else(|| "http://127.0.0.1:7490".into()),
    raw_base: env("GATE_RAW").unwrap_or_else(|| "http://127.0.0.1:7491".into()),
    ui_dist: PathBuf::from(env("GATE_UI_DIST").expect("GATE_UI_DIST")),
    ui_token: token.clone(),
    ls_seed: env("GATE_LS_SEED").and_then(|f| std::fs::read_to_string(f).ok()),
    out: out.clone(),
  };
  let api_base = cfg.api_base.clone();
  let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
  let svc = GateService::new(cfg, rt.handle().clone());

  let profile = PathBuf::from(env("GATE_PROFILE").unwrap_or_else(|| out.join("profile").to_string_lossy().into_owned()));
  let cef = Cef::default()
    .root_cache_path(profile)
    .secret_storage(SecretStorage::Mock)
    .command_line_arg("mute-audio", None::<String>)
    // A page must not make Chromium touch the local network: macOS answers that with a
    // "find devices on local networks" prompt in the app's name (seen with claude.ai/login).
    .command_line_arg("force-webrtc-ip-handling-policy", Some("disable_non_proxied_udp"))
    .disable_features(["WebRtcHideLocalIpsWithMdns", "MediaRouter", "DialMediaRouteProvider", "CastMediaRouteProvider"]);

  let (win_w, win_h) = env("GATE_WINDOW")
    .and_then(|v| v.split_once('x').and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?))))
    .unwrap_or((1280., 820.));
  let main_bridge = env("GATE_MAIN_BRIDGE").is_some();
  let park = if env("GATE_PARK").as_deref() == Some("offscreen") { Park::OffScreen } else { Park::Hide };
  let tabs_bridge = env("GATE_TABS_BRIDGE").is_some();
  let no_host = env("GATE_NO_BROWSER_HOST").is_some();
  let rt_handle = rt.handle().clone();

  tauri::Builder::default()
    .runtime(cef)
    .setup(move |app| {
      log("gate", "setup");
      // Test runs must not take the owner's focus: an accessory app never activates.
      if env("GATE_ACCESSORY").is_some() {
        let _ = app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
      }
      let window = WindowBuilder::new(app, "main")
        .title("Eos")
        .inner_size(win_w, win_h)
        .min_inner_size(800., 500.)
        .position(80., 80.)
        .focused(false)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Electron's trafficLightPosition {19,16} lands 9 px lower than the same numbers
        // here (measured on window captures), so the y that matches is 25.
        .traffic_light_position(LogicalPosition::new(19., env("GATE_TL_Y").and_then(|v| v.parse().ok()).unwrap_or(25.)))
        .build()?;
      // Created on an inert page: the in-process handler must be on the view's request
      // context before the first request for the app origin leaves.
      let mut builder = WebviewBuilder::new("main", WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .position(LogicalPosition::new(0., 0.))
        .size(LogicalSize::new(win_w, win_h))
        .focused(false)
        .auto_resize();
      if !main_bridge {
        builder = builder.no_bridge(true);
      }
      let main = window.add_child(builder)?;
      log("gate", "main view created");
      let window_number = window.ns_window().map(appkit::window_number).unwrap_or(-1);
      svc.window.set(window.clone()).ok();
      let (browser, browser_events) = Browser::new(window.clone(), park, !tabs_bridge);
      svc.browser.set(browser.clone()).ok();
      if !no_host && !token.is_empty() {
        let ws = format!("{}/browser/host?uiToken={}", api_base.replacen("http", "ws", 1), token);
        rt_handle.spawn(browser::host_channel(ws, browser.clone(), browser_events));
      }

      let gate = Arc::new(Gate {
        app: app.handle().clone(),
        window,
        svc: svc.clone(),
        browser,
        views: Views { map: Default::default(), nav_log: Default::default() },
        out: out.clone(),
        window_number,
        start_epoch_ms,
      });
      let router: Arc<dyn transport::Service> = Arc::new(Router(svc.clone()));
      std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let _ = main.with_cef_webview(move |w| {
          let _ = tx.send(transport::register(&w.browser(), &[APP_HOST, RAW_HOST], router));
        });
        match rx.recv_timeout(Duration::from_secs(5)) {
          Ok(Ok(())) => log("gate", "in-process handler registered for eos.localhost + raw.eos.localhost"),
          other => log("gate", &format!("handler registration failed: {other:?}")),
        }
        match Cdp::attach(&main) {
          Ok(cdp) => {
            cdp.on_event(|method, params| {
              if method == "Runtime.exceptionThrown" {
                log("page", &format!("exception: {}", params.pointer("/exceptionDetails/exception/description").and_then(Value::as_str).unwrap_or("?")));
              }
            });
            let _ = cdp.call("Runtime.enable", json!({}));
            gate.views.map.lock().unwrap().insert("main".into(), (main.clone(), cdp));
          }
          Err(e) => log("gate", &format!("cdp attach failed: {e}")),
        }
        let start = env("GATE_START_PATH").unwrap_or_else(|| "/index.html".into());
        if let Err(e) = main.navigate(Url::parse(&format!("http://{APP_HOST}{start}")).unwrap()) {
          log("gate", &format!("navigate failed: {e}"));
        }
        log("gate", "navigated to the dashboard");
        ctl_loop(gate);
      });
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// ---------------------------------------------------------------- file RPC

fn ctl_loop(gate: Arc<Gate>) {
  let dir = gate.out.join("ctl");
  let _ = std::fs::write(gate.out.join("ready"), std::process::id().to_string());
  loop {
    let mut reqs: Vec<PathBuf> = std::fs::read_dir(&dir)
      .into_iter()
      .flatten()
      .flatten()
      .map(|e| e.path())
      .filter(|p| p.extension().is_some_and(|e| e == "req"))
      .collect();
    reqs.sort();
    for path in reqs {
      let Ok(text) = std::fs::read_to_string(&path) else { continue };
      let _ = std::fs::remove_file(&path);
      let req: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
      let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
      let started = Instant::now();
      let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ctl(&gate, &op, &req))).unwrap_or_else(|_| Err("panic".into()));
      let res = match result {
        Ok(v) => json!({ "ok": true, "ms": started.elapsed().as_millis() as u64, "value": v }),
        Err(e) => json!({ "ok": false, "ms": started.elapsed().as_millis() as u64, "error": e }),
      };
      let tmp = path.with_extension("tmp");
      let _ = std::fs::write(&tmp, res.to_string());
      let _ = std::fs::rename(&tmp, path.with_extension("res"));
      if op == "quit" {
        log("gate", "quit requested");
        gate.app.exit(0);
        std::thread::sleep(Duration::from_secs(3));
        std::process::exit(0);
      }
    }
    std::thread::sleep(Duration::from_millis(25));
  }
}

fn view_of(gate: &Gate, label: &str) -> Result<(tauri::Webview, Cdp), String> {
  if let Some(v) = gate.views.map.lock().unwrap().get(label) {
    return Ok(v.clone());
  }
  gate.browser.tab(label).map(|t| (t.webview.clone(), t.cdp.clone())).map_err(|e| e.message)
}

fn ctl(gate: &Arc<Gate>, op: &str, req: &Value) -> Result<Value, String> {
  let s = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
  let f = |k: &str, d: f64| req.get(k).and_then(Value::as_f64).unwrap_or(d);
  let label = if s("view").is_empty() { "main".to_string() } else { s("view") };
  match op {
    "quit" => Ok(Value::Null),
    "info" => Ok(json!({
      "pid": std::process::id(),
      "windowNumber": gate.window_number,
      "startEpochMs": gate.start_epoch_ms as u64,
      "uptimeMs": START.get().map(|s| s.elapsed().as_millis() as u64),
      "views": gate.views.map.lock().unwrap().keys().cloned().collect::<Vec<_>>(),
      "browser": gate.browser.state(),
      "transport": {
        "requests": transport::REQUESTS.load(Ordering::Relaxed),
        "cancels": transport::CANCELS.load(Ordering::Relaxed),
        "proxied": gate.svc.proxied.load(Ordering::Relaxed),
        "shellCalls": gate.svc.shell_calls.load(Ordering::Relaxed),
      },
    })),
    "eval" => view_of(gate, &label)?.1.eval(&s("expr")),
    "cdp" => view_of(gate, &label)?.1.call_timeout(
      &s("method"),
      req.get("params").cloned().unwrap_or(json!({})),
      Duration::from_millis(f("timeoutMs", 8000.) as u64),
    ),
    "shot" => view_of(gate, &label)?.1.screenshot(
      &PathBuf::from(s("file")),
      if s("format").is_empty() { "png" } else { "jpeg" },
      Duration::from_millis(f("timeoutMs", 8000.) as u64),
    ),
    "view.open" => {
      let url = Url::parse(&s("url")).map_err(|e| e.to_string())?;
      let nav_log_label = label.clone();
      let gate_for_nav = gate.clone();
      let stay = s("stay");
      let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .position(LogicalPosition::new(f("x", 0.), f("y", 0.)))
        .size(LogicalSize::new(f("w", 800.), f("h", 600.)))
        .focused(false)
        .on_navigation(move |url| {
          // `stay`: a host suffix the view must not leave (the artifact viewer's policy).
          let allowed = stay.is_empty() || url.host_str().is_some_and(|h| h.ends_with(&stay)) || url.scheme() == "about";
          gate_for_nav.views.nav_log.lock().unwrap().push(json!({ "view": nav_log_label, "url": url.as_str(), "allowed": allowed }));
          allowed
        });
      if !s("profile").is_empty() {
        builder = builder.data_directory(PathBuf::from(s("profile")));
      }
      if req.get("noBridge").and_then(Value::as_bool).unwrap_or(false) {
        builder = builder.no_bridge(true);
      }
      if !s("initScript").is_empty() {
        builder = builder.initialization_script(s("initScript"));
      }
      let started = Instant::now();
      let webview = gate.window.add_child(builder).map_err(|e| e.to_string())?;
      let created_ms = started.elapsed().as_millis() as u64;
      let cdp = Cdp::attach(&webview)?;
      let gate_for_events = gate.clone();
      let event_label = label.clone();
      cdp.on_event(move |method, params| {
        // What an isolated-world script reports back (Runtime.addBinding).
        if method == "Runtime.bindingCalled" {
          gate_for_events.views.nav_log.lock().unwrap().push(json!({ "view": event_label, "binding": params.get("name"), "payload": params.get("payload") }));
        }
      });
      gate.views.map.lock().unwrap().insert(label, (webview, cdp));
      Ok(json!({ "createdMs": created_ms }))
    }
    "view.set" => {
      let (webview, _) = view_of(gate, &label)?;
      let e = |r: tauri::Result<()>| r.map_err(|e| e.to_string());
      match s("do").as_str() {
        "hide" => e(webview.hide())?,
        "show" => e(webview.show())?,
        "bounds" => {
          e(webview.set_position(LogicalPosition::new(f("x", 0.), f("y", 0.))))?;
          e(webview.set_size(LogicalSize::new(f("w", 800.), f("h", 600.))))?;
        }
        "zoom" => e(webview.set_zoom(f("zoom", 1.)))?,
        "navigate" => e(webview.navigate(Url::parse(&s("url")).map_err(|e| e.to_string())?))?,
        "front" => e(webview.with_cef_webview(|w| {
          if let Some(host) = w.browser().host() {
            appkit::bring_view_to_front(host.window_handle() as *mut std::ffi::c_void);
          }
        }))?,
        "close" => {
          gate.views.map.lock().unwrap().remove(&label);
          e(webview.close())?;
        }
        other => return Err(format!("unknown view.set do={other}")),
      }
      Ok(Value::Null)
    }
    "view.cookies" => {
      let (webview, _) = view_of(gate, &label)?;
      let cookies = webview.cookies_for_url(Url::parse(&s("url")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
      // Names only: values are credentials.
      Ok(json!(cookies.iter().map(|c| c.name().to_string()).collect::<Vec<_>>()))
    }
    "navlog" => Ok(Value::Array(std::mem::take(&mut *gate.views.nav_log.lock().unwrap()))),
    "browser" => {
      let args = req.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
      gate.browser.handle(&s("method"), &s("session"), &args).map_err(|e| format!("{}: {}", e.name, e.message))
    }
    "browser.park" => {
      *gate.browser.park.lock().unwrap() = if s("mode") == "offscreen" { Park::OffScreen } else { Park::Hide };
      Ok(Value::Null)
    }
    "emit" => {
      gate.svc.emit(&s("name"), req.get("payload").cloned().unwrap_or(Value::Null));
      Ok(Value::Null)
    }
    "bridgelog" => Ok(Value::Array(std::mem::take(&mut *gate.svc.log.lock().unwrap()))),
    "window" => {
      let e = |r: tauri::Result<()>| r.map_err(|e| e.to_string());
      match s("do").as_str() {
        "size" => e(gate.window.set_size(LogicalSize::new(f("w", 1280.), f("h", 820.))))?,
        "focus" => e(gate.window.set_focus())?,
        other => return Err(format!("unknown window do={other}")),
      }
      Ok(Value::Null)
    }
    other => Err(format!("unknown op {other}")),
  }
}
