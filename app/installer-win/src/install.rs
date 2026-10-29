// Installing and removing Eos. Everything Eos puts on the system is recorded in
// <dir>\.eos-install.json, and only what that manifest lists is ever deleted —
// a reinstall, an upgrade or an uninstall never touches anything else.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::payload::{Payload, Slice};
use crate::winapi;

const MANIFEST: &str = ".eos-install.json";
const UNINSTALLER: &str = "Uninstall Eos.exe";
const APP_EXE: &str = "Eos.exe";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Eos";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

pub struct Options {
    pub dir: PathBuf,
    pub desktop: bool,
    pub start_menu: bool,
    pub startup: bool,
}

pub enum Event {
    Step(&'static str),
    Progress { done: u64, total: u64, file: Option<String> },
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    version: String,
    files: Vec<String>,
    shortcuts: Vec<PathBuf>,
    startup: bool,
}

/// Where Eos goes when nobody picks a folder: the per-user Programs folder.
pub fn default_dir() -> PathBuf {
    winapi::local_app_data().unwrap_or_else(|| PathBuf::from(r"C:\Users\Public")).join("Programs").join("Eos")
}

/// Why `dir` can't take Eos, or None when it can.
pub fn refuse_dir(dir: &Path) -> Option<String> {
    if !dir.is_absolute() || dir.parent().is_none() {
        return Some("Choose a full folder path, like C:\\Users\\you\\Apps\\Eos.".into());
    }
    if dir.is_file() {
        return Some("That's a file — choose a folder.".into());
    }
    let has_other_things = fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false);
    if has_other_things && !dir.join(MANIFEST).exists() {
        return Some("This folder isn't empty. Choose an empty folder, or one Eos is already in.".into());
    }
    None
}

pub fn install(exe: &Path, payload: &Payload, version: &str, opts: &Options, cancel: &AtomicBool, emit: &dyn Fn(Event)) -> Result<(), String> {
    let dir = &opts.dir;
    if let Some(reason) = refuse_dir(dir) {
        return Err(reason);
    }

    emit(Event::Step("Preparing"));
    stop_running_eos();
    retire_squirrel_install(dir);
    let previous = read_manifest(dir);
    remove_files(dir, &previous.files);
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;

    emit(Event::Step("Copying Eos and its agents"));
    let mut manifest = Manifest { version: version.to_string(), ..Default::default() };
    let size = match extract(exe, payload, dir, cancel, emit, &mut manifest.files) {
        Ok(size) => size,
        Err(e) => {
            remove_files(dir, &manifest.files);
            return Err(e);
        }
    };

    emit(Event::Step("Adding shortcuts"));
    let app = dir.join(APP_EXE);
    let mut shortcuts = Vec::new();
    if opts.desktop {
        shortcuts.extend(winapi::desktop_dir().map(|d| d.join("Eos.lnk")));
    }
    if opts.start_menu {
        shortcuts.extend(winapi::start_menu_programs().map(|d| d.join("Eos.lnk")));
    }
    for lnk in &shortcuts {
        winapi::create_shortcut(lnk, &app).map_err(|e| format!("Couldn't create the shortcut {}: {e}", lnk.display()))?;
    }
    manifest.shortcuts = shortcuts;
    set_startup(opts.startup.then_some(app.as_path())).map_err(|e| format!("Couldn't set Eos to open at sign-in: {e}"))?;
    manifest.startup = opts.startup;

    emit(Event::Step("Getting Eos ready to open"));
    write_uninstaller(exe, payload, dir).map_err(|e| format!("Couldn't write the uninstaller: {e}"))?;
    manifest.files.push(UNINSTALLER.to_string());
    register_uninstall(dir, version, size).map_err(|e| format!("Couldn't register Eos with Windows: {e}"))?;
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST), json).map_err(|e| format!("Couldn't save the install record: {e}"))?;
    Ok(())
}

fn damaged(e: &dyn std::fmt::Display) -> String {
    format!("The installer is damaged ({e}). Download Eos again.")
}

fn open_zip(exe: &Path, payload: &Payload) -> Result<zip::ZipArchive<Slice>, String> {
    let slice = Slice::open(exe, payload).map_err(|e| damaged(&e))?;
    zip::ZipArchive::new(slice).map_err(|e| damaged(&e))
}

fn total_size(zip: &mut zip::ZipArchive<Slice>) -> u64 {
    (0..zip.len()).filter_map(|i| zip.by_index_raw(i).ok().map(|f| f.size())).sum()
}

/// What Eos takes on disk once installed.
pub fn payload_size(exe: &Path, payload: &Payload) -> Result<u64, String> {
    open_zip(exe, payload).map(|mut zip| total_size(&mut zip))
}

// Returns the bytes written.
fn extract(exe: &Path, payload: &Payload, dir: &Path, cancel: &AtomicBool, emit: &dyn Fn(Event), written: &mut Vec<String>) -> Result<u64, String> {
    let mut zip = open_zip(exe, payload)?;

    // Forge's zip holds one top folder (Eos-win32-<arch>\); the app goes straight into `dir`.
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let prefix = common_top_folder(&names);
    let total = total_size(&mut zip);

    let mut done = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buf = vec![0u8; 256 * 1024];
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| damaged(&e))?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let rel = rel.strip_prefix(&prefix).unwrap_or(&rel).to_path_buf();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut out = File::create(&target).map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
        written.push(rel.to_string_lossy().into_owned());
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = entry.read(&mut buf).map_err(|e| damaged(&e))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("Couldn't write {} ({e}). Is the disk full?", target.display()))?;
            done += n as u64;
            if last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = Instant::now();
                emit(Event::Progress { done, total, file: None });
            }
        }
        if rel.components().count() <= 3 && entry.size() > 1024 * 1024 {
            emit(Event::Progress { done, total, file: Some(rel.to_string_lossy().into_owned()) });
        }
    }
    emit(Event::Progress { done: total, total, file: None });
    Ok(total)
}

fn common_top_folder(names: &[String]) -> PathBuf {
    let first = names.iter().find_map(|n| Path::new(n).components().next());
    match first {
        Some(Component::Normal(top)) if names.iter().all(|n| Path::new(n).starts_with(top)) => PathBuf::from(top),
        _ => PathBuf::new(),
    }
}

fn read_manifest(dir: &Path) -> Manifest {
    fs::read(dir.join(MANIFEST)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

// Files first, then the folders they leave empty, deepest first.
fn remove_files(dir: &Path, files: &[String]) {
    let mut parents = Vec::new();
    for rel in files {
        let path = dir.join(rel);
        let _ = fs::remove_file(&path);
        parents.extend(path.ancestors().skip(1).take_while(|p| *p != dir).map(Path::to_path_buf));
    }
    parents.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    parents.dedup();
    for p in parents {
        let _ = fs::remove_dir(&p);
    }
}

// Eos's files are locked while it runs — its daemon is Eos.exe too.
fn stop_running_eos() {
    let _ = Command::new("taskkill").args(["/IM", APP_EXE, "/T", "/F"]).creation_flags(CREATE_NO_WINDOW).output();
    std::thread::sleep(Duration::from_millis(400));
}

// Eos 0.1.x came through Squirrel (%LOCALAPPDATA%\Eos with its Update.exe): uninstall it
// the way it installed, so one Eos is left.
fn retire_squirrel_install(target: &Path) {
    let Some(old) = winapi::local_app_data().map(|d| d.join("Eos")) else { return };
    let update = old.join("Update.exe");
    if !update.exists() {
        return;
    }
    let _ = Command::new(&update).args(["--uninstall", "-s"]).creation_flags(CREATE_NO_WINDOW).output();
    if old != target && !old.join(MANIFEST).exists() {
        let _ = fs::remove_dir_all(&old);
    }
}

// The uninstaller is this exe without its payload.
fn write_uninstaller(exe: &Path, payload: &Payload, dir: &Path) -> io::Result<()> {
    let mut src = File::open(exe)?.take(payload.offset);
    let mut dst = File::create(dir.join(UNINSTALLER))?;
    io::copy(&mut src, &mut dst)?;
    Ok(())
}

fn register_uninstall(dir: &Path, version: &str, size: u64) -> io::Result<()> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(UNINSTALL_KEY)?;
    let uninstaller = dir.join(UNINSTALLER);
    key.set_value("DisplayName", &"Eos")?;
    key.set_value("DisplayVersion", &version)?;
    key.set_value("Publisher", &"Eos")?;
    key.set_value("DisplayIcon", &dir.join(APP_EXE).to_string_lossy().into_owned())?;
    key.set_value("InstallLocation", &dir.to_string_lossy().into_owned())?;
    key.set_value("UninstallString", &format!("\"{}\" --uninstall", uninstaller.display()))?;
    key.set_value("QuietUninstallString", &format!("\"{}\" --uninstall --silent", uninstaller.display()))?;
    key.set_value("EstimatedSize", &((size / 1024) as u32))?;
    key.set_value("NoModify", &1u32)?;
    key.set_value("NoRepair", &1u32)?;
    Ok(())
}

fn set_startup(app: Option<&Path>) -> io::Result<()> {
    let (run, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
    match app {
        Some(app) => run.set_value("Eos", &format!("\"{}\"", app.display())),
        None => match run.delete_value("Eos") {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

pub fn launch(dir: &Path) -> io::Result<()> {
    Command::new(dir.join(APP_EXE)).current_dir(dir).creation_flags(DETACHED_PROCESS).spawn().map(|_| ())
}

/// Removes everything the manifest in `dir` lists, then (once this process exits) the folder itself.
pub fn uninstall(dir: &Path) {
    stop_running_eos();
    let manifest = read_manifest(dir);
    for lnk in &manifest.shortcuts {
        let _ = fs::remove_file(lnk);
    }
    let _ = set_startup(None);
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(UNINSTALL_KEY);
    let mut files = manifest.files;
    files.retain(|f| f != UNINSTALLER);
    remove_files(dir, &files);
    let _ = fs::remove_file(dir.join(MANIFEST));
    // This exe is the uninstaller and can't delete itself while it runs.
    let script = format!("ping 127.0.0.1 -n 3 > nul & del /f /q \"{}\" & rmdir \"{}\"", dir.join(UNINSTALLER).display(), dir.display());
    let _ = Command::new("cmd").args(["/d", "/c", &script]).creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS).spawn();
}
