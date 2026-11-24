//! What the bridges need from the native side. `eos-shell` implements it with the window
//! and AppKit; tests use a fake. Every method may block and is called off the request thread.

use std::path::{Path, PathBuf};

/// An editing command of the Edit menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EditCommand {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

impl EditCommand {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "undo" => EditCommand::Undo,
            "redo" => EditCommand::Redo,
            "cut" => EditCommand::Cut,
            "copy" => EditCommand::Copy,
            "paste" => EditCommand::Paste,
            "selectAll" => EditCommand::SelectAll,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            EditCommand::Undo => "undo",
            EditCommand::Redo => "redo",
            EditCommand::Cut => "cut",
            EditCommand::Copy => "copy",
            EditCommand::Paste => "paste",
            EditCommand::SelectAll => "selectAll",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
}

impl Theme {
    pub fn parse(name: &str) -> Self {
        if name == "light" { Theme::Light } else { Theme::Dark }
    }

    pub fn name(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
        }
    }
}

/// Where a click on a banner leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BannerTarget {
    /// Open this worker's chat.
    Worker(String),
    /// Open a named view (`memory`, `transfers`, …).
    Route(String),
}

/// A native notification banner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Banner {
    pub title: String,
    pub body: String,
    pub target: Option<BannerTarget>,
    /// The paired computer it was raised on: a click opens it in that computer's view.
    pub host: Option<String>,
}

/// The app as a login item (Start at login), as the system reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItem {
    /// No login item here: macOS 12, or a build that is not the installed app.
    Unavailable,
    On,
    Off,
    /// Registered, waiting for the user's approval in System Settings › Login Items.
    NeedsApproval,
}

impl LoginItem {
    pub fn name(self) -> &'static str {
        match self {
            LoginItem::On => "on",
            LoginItem::Unavailable | LoginItem::Off => "off",
            LoginItem::NeedsApproval => "needs-approval",
        }
    }
}

/// The quick panel's global shortcut, as registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
    /// The one asked for (`alt+space`), or the fallback when that was taken.
    pub accelerator: String,
    /// Whether the system holds it for Eos.
    pub held: bool,
    /// Why the one asked for does not hold, in the user's words.
    pub problem: Option<String>,
}

pub trait ShellHost: Send + Sync + 'static {
    /// Starts a native window drag from the mouse press being handled.
    fn start_window_drag(&self);
    /// What a double click on the title bar does (zoom, by the system setting).
    fn toggle_window_zoom(&self);
    /// Whether the main window is the focused window of the frontmost app.
    fn window_focused(&self) -> bool;
    /// The theme the dashboard switched to: the window paints its background with it.
    fn set_theme(&self, theme: Theme);
    /// Shows a banner with the app's sound. A click activates the app and reports the
    /// target back through `Bridge::banner_clicked`.
    fn show_banner(&self, banner: Banner);
    fn clipboard_text(&self) -> Option<String>;
    fn set_clipboard_text(&self, text: &str);
    /// Paths of files copied in the file manager, or none.
    fn clipboard_file_paths(&self) -> Vec<String>;
    /// Whether the clipboard holds an image or files rather than text.
    fn clipboard_has_files(&self) -> bool;
    /// Real paths of the files the dashboard was just handed in a drop.
    fn dropped_file_paths(&self) -> Vec<String>;
    /// Runs the command natively on the dashboard's focused frame.
    fn edit(&self, command: EditCommand);
    /// Opens a file or folder with its default app.
    fn open_path(&self, path: &Path);
    fn downloads_dir(&self) -> PathBuf;
    /// The login item's state, read from the system each time: the user may change it in
    /// System Settings.
    fn login_item(&self) -> LoginItem;
    /// Registers the app as a login item or removes it; answers the state after.
    fn set_login_item(&self, on: bool) -> LoginItem;
    /// Opens System Settings › General › Login Items.
    fn open_login_items_settings(&self);
    /// Where the app's `eos` command is and where its link goes; `None` for an app that owns
    /// no door (a dev or test run) or ships no command.
    fn cli_command(&self) -> Option<crate::cli_link::CliCommand> {
        None
    }
    /// The shortcut that opens the quick panel as the system holds it; `None` for an app that
    /// owns no door (a dev or test run registers none).
    fn shortcut(&self) -> Option<Shortcut> {
        None
    }
    /// Registers this shortcut instead, remembering it when it holds; answers what holds after.
    fn set_shortcut(&self, _accelerator: &str) -> Option<Shortcut> {
        None
    }
    /// Closes the quick panel; focus stays with the app that had it.
    fn close_panel(&self) {}
    /// Fits the quick panel to its page, in points, already within
    /// [`crate::doors::panel_size`]'s bounds.
    fn size_panel(&self, _width: f64, _height: f64) {}
}
