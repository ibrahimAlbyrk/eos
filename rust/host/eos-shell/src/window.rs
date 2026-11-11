//! The main window: hidden title bar with the traffic lights where the dashboard expects
//! them, opened where it was last time.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use eos_bridge::Theme;
use eos_bridge::window_state::{DEFAULT_SIZE, MIN_SIZE, Screen, WindowState};
use tauri::window::WindowBuilder;
use tauri::{LogicalPosition, TitleBarStyle};

use crate::host::background;

/// Electron's `trafficLightPosition {19, 16}` lands 9 px lower than the same numbers here
/// (measured on window captures in the shell gate); y = 25 matches it to the pixel.
const TRAFFIC_LIGHTS: (f64, f64) = (19.0, 25.0);
/// Where a first launch opens.
const FIRST_POSITION: (f64, f64) = (120.0, 80.0);

fn screens(app: &tauri::AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let (position, size) = (m.position().to_logical::<f64>(scale), m.size().to_logical::<f64>(scale));
            Screen { x: position.x, y: position.y, width: size.width, height: size.height }
        })
        .collect()
}

pub(crate) fn state_file(data_dir: &Path) -> PathBuf {
    data_dir.join("window.json")
}

/// Creates the window. `quiet` opens it without taking the focus (automated runs).
pub(crate) fn create(
    app: &tauri::AppHandle,
    data_dir: &Path,
    theme: Theme,
    quiet: bool,
) -> tauri::Result<(tauri::Window, WindowState)> {
    let saved = WindowState::load(&state_file(data_dir));
    let state = saved
        .unwrap_or(WindowState {
            x: FIRST_POSITION.0,
            y: FIRST_POSITION.1,
            width: DEFAULT_SIZE.0,
            height: DEFAULT_SIZE.1,
            maximized: false,
            fullscreen: false,
        })
        .fitted(&screens(app));
    let window = WindowBuilder::new(app, "main")
        .title("Eos")
        .inner_size(state.width, state.height)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .position(state.x, state.y)
        .focused(!quiet)
        .background_color(background(theme))
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(TRAFFIC_LIGHTS.0, TRAFFIC_LIGHTS.1))
        .build()?;
    if state.maximized {
        let _ = window.maximize();
    }
    if state.fullscreen && !quiet {
        let _ = window.set_fullscreen(true);
    }
    Ok((window, state))
}

/// Keeps the window's frame on disk, written at most twice a second while it moves.
pub(crate) struct StateKeeper {
    path: PathBuf,
    last_write: Mutex<Option<Instant>>,
    fullscreen: AtomicBool,
}

impl StateKeeper {
    pub(crate) fn new(data_dir: &Path, fullscreen: bool) -> Self {
        StateKeeper {
            path: state_file(data_dir),
            last_write: Mutex::new(None),
            fullscreen: AtomicBool::new(fullscreen),
        }
    }

    fn read(window: &tauri::Window) -> Option<WindowState> {
        let scale = window.scale_factor().ok()?;
        let position = window.outer_position().ok()?.to_logical::<f64>(scale);
        let size = window.inner_size().ok()?.to_logical::<f64>(scale);
        Some(WindowState {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: window.is_maximized().unwrap_or(false),
            fullscreen: window.is_fullscreen().unwrap_or(false),
        })
    }

    /// The window moved or changed size. Returns the new fullscreen state when it changed.
    pub(crate) fn changed(&self, window: &tauri::Window, force: bool) -> Option<bool> {
        let state = Self::read(window)?;
        let flipped = self.fullscreen.swap(state.fullscreen, Ordering::SeqCst) != state.fullscreen;
        let due = {
            let mut last = self.last_write.lock().unwrap_or_else(|p| p.into_inner());
            let due = force || last.is_none_or(|at| at.elapsed() > Duration::from_millis(500));
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        // A maximized or fullscreen frame is not where the window lives: keep the last
        // plain frame and only the flags.
        if due {
            let keep = match WindowState::load(&self.path) {
                Some(previous) if state.maximized || state.fullscreen => {
                    WindowState { maximized: state.maximized, fullscreen: state.fullscreen, ..previous }
                }
                _ => state,
            };
            let _ = keep.save(&self.path);
        }
        flipped.then_some(state.fullscreen)
    }
}
