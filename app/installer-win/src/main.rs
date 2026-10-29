// Eos Setup — the Windows installer (and, without its payload, the uninstaller).
//
//   Eos-Setup-<arch>.exe                          the window (ui/index.html in a WebView2)
//   Eos-Setup-<arch>.exe --silent [--dir D] [--no-launch]   install with the defaults, no window
//   Uninstall Eos.exe --uninstall [--silent]      remove Eos

#![windows_subsystem = "windows"]

mod install;
mod payload;
mod update;
mod winapi;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::WindowBuilder;
use wry::http::{header::CONTENT_TYPE, Request, Response};
use wry::WebViewBuilder;

use crate::install::Options;
use crate::payload::Payload;

const VERSION: &str = match option_env!("EOS_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};
const ARCH: &str = if cfg!(target_arch = "aarch64") { "ARM64" } else { "x64" };

enum UserEvent {
    Ipc(String),
    Js(String),
    Exit,
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    Ready,
    Dir { dir: String },
    Browse,
    #[serde(rename_all = "camelCase")]
    Install { dir: String, desktop: bool, start_menu: bool, startup: bool },
    Cancel,
    Minimize,
    Close,
    Drag,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let exe = std::env::current_exe().expect("own path");

    if flag("--uninstall") {
        return uninstall(&exe, flag("--silent"));
    }
    if let Some(pending) = value("--apply") {
        return update::apply(Path::new(&pending));
    }
    let payload = match payload::find(&exe) {
        Ok(Some(p)) => p,
        Ok(None) => return fail("This copy of Eos Setup has nothing to install. Download Eos again from its releases page."),
        Err(e) => return fail(&e.to_string()),
    };
    if flag("--silent") {
        let dir = value("--dir").map(PathBuf::from).unwrap_or_else(install::default_dir);
        let opts = Options { dir, desktop: true, start_menu: true, startup: false };
        let result = install::install(&exe, &payload, VERSION, &opts, &AtomicBool::new(false), &|_| {});
        match result {
            Ok(()) if !flag("--no-launch") => {
                let _ = install::launch(&opts.dir);
            }
            Ok(()) => {}
            Err(e) => {
                let _ = std::fs::write(std::env::temp_dir().join("eos-setup.log"), &e);
                std::process::exit(1);
            }
        }
        return;
    }
    run_window(exe, payload);
}

fn uninstall(exe: &Path, silent: bool) {
    let Some(dir) = exe.parent() else { return };
    if !silent && !winapi::confirm("Uninstall Eos", "Remove Eos from this computer?\n\nYour chats, agents and settings in your .eos folder stay.") {
        return;
    }
    install::uninstall(dir);
}

fn fail(message: &str) {
    let _ = std::fs::write(std::env::temp_dir().join("eos-setup.log"), message);
    winapi::confirm("Eos Setup", message);
    std::process::exit(1);
}

fn asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    Some(match path {
        "/" | "/index.html" => (include_bytes!("../ui/index.html"), "text/html; charset=utf-8"),
        "/assets/geist.woff2" => (include_bytes!("../ui/assets/geist.woff2"), "font/woff2"),
        "/assets/plex-mono.woff2" => (include_bytes!("../ui/assets/plex-mono.woff2"), "font/woff2"),
        "/assets/logo.png" => (include_bytes!("../ui/assets/logo.png"), "image/png"),
        _ => return None,
    })
}

fn space(dir: &Path, needed: u64) -> serde_json::Value {
    if let Some(reason) = install::refuse_dir(dir) {
        return json!({ "ok": false, "reason": reason });
    }
    match winapi::free_space(dir) {
        Some((free, drive)) if free >= needed => json!({ "ok": true, "free": free, "drive": drive }),
        Some((free, drive)) => json!({
            "ok": false,
            "reason": format!("Not enough space on {drive}: Eos needs {} MB, {} MB are free.", needed / 1_048_576, free / 1_048_576),
        }),
        None => json!({ "ok": false, "reason": "That drive can't be reached." }),
    }
}

fn run_window(exe: PathBuf, payload: Payload) {
    let needed = install::payload_size(&exe, &payload).unwrap_or(payload.len);
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Eos Setup")
        .with_inner_size(LogicalSize::new(760.0, 480.0))
        .with_resizable(false)
        .with_maximizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .build(&event_loop)
        .expect("window");
    winapi::round_corners(window.hwnd() as isize);

    let ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_custom_protocol("eos".into(), |_id, request: Request<Vec<u8>>| {
            let (body, mime) = asset(request.uri().path()).unwrap_or((b"" as &[u8], "text/plain"));
            Response::builder().header(CONTENT_TYPE, mime).body(Cow::Borrowed(body)).unwrap()
        })
        .with_url("eos://localhost/index.html")
        .with_background_color((16, 16, 16, 255))
        .with_ipc_handler(move |req: Request<String>| {
            let _ = ipc.send_event(UserEvent::Ipc(req.into_body()));
        })
        .build(&window)
        .expect("webview (needs Microsoft Edge WebView2, part of Windows 10 and 11)");

    let cancel = Arc::new(AtomicBool::new(false));
    let installing = Arc::new(AtomicBool::new(false));
    let closing = Arc::new(AtomicBool::new(false));
    let mut dir = install::default_dir();

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Exit) => *flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Js(script)) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let Ok(cmd) = serde_json::from_str::<Command>(&body) else { return };
                match cmd {
                    Command::Ready => {
                        let init = json!({
                            "type": "init", "version": VERSION, "platform": format!("Windows · {ARCH}"),
                            "dir": dir.display().to_string(), "needed": needed, "space": space(&dir, needed),
                        });
                        let _ = webview.evaluate_script(&format!("window.eos.on({init})"));
                        window.set_visible(true);
                    }
                    Command::Dir { dir: d } => {
                        dir = PathBuf::from(d);
                        let mut msg = json!({ "type": "space" });
                        merge(&mut msg, space(&dir, needed));
                        let _ = webview.evaluate_script(&format!("window.eos.on({msg})"));
                    }
                    Command::Browse => {
                        let start = dir.ancestors().find(|p| p.exists()).map(Path::to_path_buf);
                        let mut dialog = rfd::FileDialog::new().set_title("Choose where to install Eos");
                        if let Some(s) = start {
                            dialog = dialog.set_directory(s);
                        }
                        if let Some(picked) = dialog.pick_folder() {
                            // A picked parent folder gets its own Eos folder inside it.
                            dir = if picked.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Eos")) { picked } else { picked.join("Eos") };
                            let mut msg = json!({ "type": "space" });
                            merge(&mut msg, space(&dir, needed));
                            let _ = webview.evaluate_script(&format!("window.eos.on({})", json!({ "type": "dir", "dir": dir.display().to_string() })));
                            let _ = webview.evaluate_script(&format!("window.eos.on({msg})"));
                        }
                    }
                    Command::Install { dir: d, desktop, start_menu, startup } => {
                        if installing.swap(true, Ordering::SeqCst) {
                            return;
                        }
                        dir = PathBuf::from(d);
                        cancel.store(false, Ordering::SeqCst);
                        let opts = Options { dir: dir.clone(), desktop, start_menu, startup };
                        let job = Job { cancel: cancel.clone(), installing: installing.clone(), closing: closing.clone(), proxy: proxy.clone() };
                        let (exe, payload) = (exe.clone(), Payload { offset: payload.offset, len: payload.len });
                        std::thread::spawn(move || run_install(&exe, &payload, &opts, &job));
                    }
                    Command::Cancel => cancel.store(true, Ordering::SeqCst),
                    Command::Minimize => window.set_minimized(true),
                    Command::Close => {
                        if installing.load(Ordering::SeqCst) {
                            // Stop, undo, then leave: run_install exits once it has cleaned up.
                            closing.store(true, Ordering::SeqCst);
                            cancel.store(true, Ordering::SeqCst);
                        } else {
                            *flow = ControlFlow::Exit;
                        }
                    }
                    Command::Drag => {
                        let _ = window.drag_window();
                    }
                }
            }
            _ => {}
        }
    });
}

fn merge(into: &mut serde_json::Value, from: serde_json::Value) {
    if let (Some(a), serde_json::Value::Object(b)) = (into.as_object_mut(), from) {
        a.extend(b);
    }
}

// What an install running on its own thread shares with the window.
struct Job {
    cancel: Arc<AtomicBool>,
    installing: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    proxy: EventLoopProxy<UserEvent>,
}

fn run_install(exe: &Path, payload: &Payload, opts: &Options, job: &Job) {
    let proxy = &job.proxy;
    let js = |v: serde_json::Value| {
        let _ = proxy.send_event(UserEvent::Js(format!("window.eos.on({v})")));
    };
    let emit = |e: install::Event| match e {
        install::Event::Step(label) => js(json!({ "type": "step", "label": label })),
        install::Event::Progress { done, total, file } => js(json!({ "type": "progress", "done": done, "total": total, "file": file })),
    };
    let result = install::install(exe, payload, VERSION, opts, &job.cancel, &emit);
    job.installing.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            js(json!({
                "type": "done", "dir": opts.dir.display().to_string(),
                "desktop": opts.desktop, "startMenu": opts.start_menu, "startup": opts.startup,
            }));
            // Eos opens on its own; the window steps aside once it's up.
            std::thread::sleep(Duration::from_millis(900));
            if install::launch(&opts.dir).is_ok() {
                std::thread::sleep(Duration::from_millis(1500));
                js(json!({ "type": "opened" }));
                std::thread::sleep(Duration::from_millis(2500));
                let _ = proxy.send_event(UserEvent::Exit);
            }
        }
        Err(_) if job.closing.load(Ordering::SeqCst) => {
            let _ = proxy.send_event(UserEvent::Exit);
        }
        Err(_) if job.cancel.load(Ordering::SeqCst) => js(json!({ "type": "cancelled" })),
        Err(e) => js(json!({ "type": "error", "message": e })),
    }
}
