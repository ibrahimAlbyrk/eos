//! The splash shown while the app restarts into an update: a small frameless panel above
//! every window, from the hand-over until the app has quit, or closed again when the
//! restart failed.

use std::path::Path;
use std::sync::Mutex;

use eos_bridge::splash::{SIZE, splash_html, splash_url};

use crate::views::create;

#[derive(Default)]
pub(crate) struct Splash {
    window: Mutex<Option<tauri::Window>>,
}

impl Splash {
    /// Shows `caption` under the logo of the dashboard in `dist`. Blocking.
    pub(crate) fn show(&self, app: &tauri::AppHandle, dist: &Path, caption: &str) -> Result<(), String> {
        let mut shown = self.window.lock().unwrap_or_else(|p| p.into_inner());
        if shown.is_some() {
            return Ok(());
        }
        let window = tauri::window::WindowBuilder::new(app, "splash")
            .title("Eos")
            .inner_size(SIZE.0, SIZE.1)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .center()
            .build()
            .map_err(|e| e.to_string())?;
        // Its own document only: nothing else may load, nothing opens.
        let policy = create::Policy {
            navigation: Box::new(|url| matches!(url.scheme(), "data" | "about")),
            open_requested: Box::new(|_| {}),
        };
        let builder = create::builder("splash-view", (0.0, 0.0), SIZE, None, policy).transparent(true);
        let view = window.add_child(builder).map_err(|e| e.to_string())?;
        let logo = std::fs::read(dist.join("logo.png")).ok();
        let page = splash_url(&splash_html(caption, logo.as_deref()));
        view.navigate(tauri::Url::parse(&page).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        *shown = Some(window);
        Ok(())
    }

    pub(crate) fn shown(&self) -> bool {
        self.window.lock().unwrap_or_else(|p| p.into_inner()).is_some()
    }

    pub(crate) fn close(&self) {
        if let Some(window) = self.window.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = window.close();
        }
    }
}
