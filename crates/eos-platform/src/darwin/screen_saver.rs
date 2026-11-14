//! The screen saver on macOS: installed into `~/Library/Screen Savers`, started by the
//! login window's screen-saver daemon.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::error::Error;
use crate::host::ScreenSaver;
use crate::paths::home_dir;
use crate::screen_saver::{SCREEN_SAVER_BUNDLE, install_screen_saver};
use crate::tool;

const TIMEOUT: Duration = Duration::from_secs(15);

/// Asks loginwindow's screen-saver daemon (the one behind the idle timer) to start the
/// saver, so it runs on every display. `open -a ScreenSaverEngine` runs the engine in its
/// own process instead, which shows the saver on one display only.
pub const START_SCREEN_SAVER: &str =
    "ObjC.import(\"ScreenSaver\"); $.ScreenSaverController.controller.screenSaverStartNow";

/// The settings pane where the user picks a screen saver. macOS 26+ folded the Screen Saver
/// pane into Wallpaper (as a "Screen Saver…" sheet with no deep link); an unknown pane id
/// silently opens General instead.
pub fn screen_saver_settings_url(macos_major: u32) -> String {
    let pane = if macos_major >= 26 {
        "com.apple.Wallpaper-Settings.extension"
    } else {
        "com.apple.ScreenSaver-Settings.extension"
    };
    format!("x-apple.systempreferences:{pane}")
}

fn macos_major() -> u32 {
    tool::run_ok(
        "sysctl",
        Command::new("/usr/sbin/sysctl").args(["-n", "kern.osproductversion"]),
        None,
        Duration::from_secs(2),
    )
    .ok()
    .and_then(|out| out.stdout.trim().split('.').next()?.parse().ok())
    .unwrap_or(0)
}

#[derive(Debug)]
pub(crate) struct MacScreenSaver;

impl ScreenSaver for MacScreenSaver {
    // macOS has no supported way to select a saver programmatically, so picking "Eos" in
    // the settings pane is the user's one step.
    fn install(&self, resources: &Path) -> Result<(), Error> {
        let home = home_dir().ok_or(Error::Unsupported("a home folder"))?;
        let savers = home.join("Library").join("Screen Savers");
        install_screen_saver(&resources.join(SCREEN_SAVER_BUNDLE), &savers)?;
        tool::run_ok("open", Command::new("/usr/bin/open").arg(screen_saver_settings_url(macos_major())), None, TIMEOUT)
            .map(drop)
    }

    // With "Require password immediately" set in Lock Screen settings this is a real lock;
    // the Mac itself stays awake for the phone.
    fn start(&self) -> Result<(), Error> {
        tool::run_ok(
            "osascript",
            Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", START_SCREEN_SAVER]),
            None,
            TIMEOUT,
        )
        .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_pane_follows_the_system_version() {
        assert_eq!(screen_saver_settings_url(15), "x-apple.systempreferences:com.apple.ScreenSaver-Settings.extension");
        assert_eq!(screen_saver_settings_url(26), "x-apple.systempreferences:com.apple.Wallpaper-Settings.extension");
        assert_eq!(screen_saver_settings_url(27), "x-apple.systempreferences:com.apple.Wallpaper-Settings.extension");
    }

    #[test]
    fn the_saver_starts_through_the_login_window_daemon() {
        assert!(START_SCREEN_SAVER.contains("ScreenSaverController.controller.screenSaverStartNow"));
        assert!(!START_SCREEN_SAVER.contains("ScreenSaverEngine"));
    }

    #[test]
    fn the_system_version_is_read() {
        assert!(macos_major() >= 14);
    }
}
