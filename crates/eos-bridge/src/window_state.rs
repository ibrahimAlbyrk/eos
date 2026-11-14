//! Where the main window was: kept across launches and corrected for the screens there are
//! now (a display unplugged since must not leave the window out of reach).

use std::path::Path;

use serde_json::{Value, json};

/// A window frame in logical pixels, in the system's global coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// A screen's visible area, same coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const DEFAULT_SIZE: (f64, f64) = (1280.0, 820.0);
pub const MIN_SIZE: (f64, f64) = (800.0, 500.0);
/// How much of the title strip must stay on a screen for the window to be reachable.
const GRIP: f64 = 80.0;

impl WindowState {
    pub fn load(path: &Path) -> Option<Self> {
        let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let n = |key: &str| value.get(key).and_then(Value::as_f64).filter(|v| v.is_finite());
        let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        Some(WindowState {
            x: n("x")?,
            y: n("y")?,
            width: n("width")?,
            height: n("height")?,
            maximized: flag("maximized"),
            fullscreen: flag("fullscreen"),
        })
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = json!({ "x": self.x, "y": self.y, "width": self.width, "height": self.height, "maximized": self.maximized, "fullscreen": self.fullscreen });
        std::fs::write(path, body.to_string())
    }

    /// The frame to open with: at least the minimum size, no larger than the screen it is
    /// on, and with its title strip reachable. A frame on no screen is centred on the first.
    pub fn fitted(self, screens: &[Screen]) -> Self {
        let mut s = self;
        s.width = s.width.max(MIN_SIZE.0);
        s.height = s.height.max(MIN_SIZE.1);
        let Some(first) = screens.first() else { return s };
        let reachable = |screen: &Screen| {
            let overlap = (s.x + s.width).min(screen.x + screen.width) - s.x.max(screen.x);
            overlap >= GRIP && s.y >= screen.y && s.y <= screen.y + screen.height - GRIP
        };
        match screens.iter().find(|screen| reachable(screen)) {
            Some(screen) => {
                s.width = s.width.min(screen.width);
                s.height = s.height.min(screen.height);
            }
            None => {
                s.width = s.width.min(first.width);
                s.height = s.height.min(first.height);
                s.x = first.x + ((first.width - s.width) / 2.0).round();
                s.y = first.y + ((first.height - s.height) / 2.0).round();
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    const LAPTOP: Screen = Screen { x: 0.0, y: 25.0, width: 1512.0, height: 920.0 };
    const SIDE: Screen = Screen { x: 1512.0, y: 0.0, width: 2560.0, height: 1415.0 };

    fn state(x: f64, y: f64, width: f64, height: f64) -> WindowState {
        WindowState { x, y, width, height, maximized: false, fullscreen: false }
    }

    #[test]
    fn saved_and_loaded() {
        let dir = Dir::new("window");
        let path = dir.path().join("deep/window.json");
        let s = WindowState { maximized: true, ..state(120.0, 80.0, 1400.0, 900.0) };
        s.save(&path).unwrap();
        assert_eq!(WindowState::load(&path), Some(s));
        std::fs::write(&path, "{\"x\":1}").unwrap();
        assert_eq!(WindowState::load(&path), None, "an incomplete file is no state");
        std::fs::write(&path, "garbage").unwrap();
        assert_eq!(WindowState::load(&path), None);
    }

    #[test]
    fn a_frame_on_a_screen_stays_where_it_was() {
        let s = state(100.0, 60.0, 1280.0, 820.0);
        assert_eq!(s.fitted(&[LAPTOP, SIDE]), s);
        let on_side = state(2000.0, 200.0, 1600.0, 1000.0);
        assert_eq!(on_side.fitted(&[LAPTOP, SIDE]), on_side);
    }

    #[test]
    fn a_frame_on_an_unplugged_screen_is_centred_on_the_first() {
        let lost = state(2000.0, 200.0, 1600.0, 1000.0);
        let s = lost.fitted(&[LAPTOP]);
        assert_eq!((s.width, s.height), (1512.0, 920.0), "no larger than the screen");
        assert_eq!((s.x, s.y), (0.0, 25.0));
        let small = state(-5000.0, -5000.0, 900.0, 600.0).fitted(&[LAPTOP]);
        assert_eq!((small.x, small.y), (306.0, 185.0));
    }

    #[test]
    fn a_title_strip_above_or_below_the_screen_is_not_reachable() {
        assert_ne!(state(100.0, -200.0, 1000.0, 700.0).fitted(&[LAPTOP]).y, -200.0);
        assert_ne!(state(100.0, 940.0, 1000.0, 700.0).fitted(&[LAPTOP]).y, 940.0);
        // A sliver on the side is not enough either.
        assert_ne!(state(1480.0, 100.0, 1000.0, 700.0).fitted(&[LAPTOP]).x, 1480.0);
    }

    #[test]
    fn never_smaller_than_the_minimum() {
        let s = state(100.0, 100.0, 200.0, 100.0).fitted(&[LAPTOP]);
        assert_eq!((s.width, s.height), MIN_SIZE);
        assert_eq!(state(0.0, 0.0, 10.0, 10.0).fitted(&[]).width, MIN_SIZE.0);
    }
}
