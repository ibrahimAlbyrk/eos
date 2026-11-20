//! The menu-bar item: proof that Eos is on duty, and a place to stop routines or quit on
//! purpose. It shows counts and, for the next run, a routine's name: never more of a
//! routine, and nothing of it in the log.

use std::sync::Mutex;

use eos_bridge::LoginItem;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

/// What the menu-bar item shows. Plain data: the app hands a new one in on every change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MenuState {
    /// The Eos preview is on or a routine exists: the item, and the Quit confirm, show only
    /// then.
    pub shown: bool,
    /// Runs of routines working now.
    pub working: u32,
    /// Items open in Needs you.
    pub needs_you: u32,
    /// Every routine is stopped ("Stop all routines").
    pub halted: bool,
    /// The routine that runs next on a schedule.
    pub next: Option<NextRun>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextRun {
    /// The routine's name.
    pub name: String,
    /// When, in milliseconds since the epoch.
    pub at_ms: i64,
}

/// What a click on one of the item's entries asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    NeedsYou,
    Open,
    Halt,
    Resume,
    Login,
    Quit,
}

impl Action {
    fn id(self) -> &'static str {
        match self {
            Action::NeedsYou => "tray:needs",
            Action::Open => "tray:open",
            Action::Halt => "tray:halt",
            Action::Resume => "tray:resume",
            Action::Login => "tray:login",
            Action::Quit => "tray:quit",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        [Action::NeedsYou, Action::Open, Action::Halt, Action::Resume, Action::Login, Action::Quit]
            .into_iter()
            .find(|action| action.id() == id)
    }
}

/// One entry of the item's menu.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    /// A line that only tells.
    Line(String),
    Command(Action, String),
    /// Start at Login: checked, and whether it can be changed here.
    Login {
        checked: bool,
        enabled: bool,
    },
    Separator,
}

fn working_line(working: u32) -> String {
    match working {
        0 => "Nothing running".to_owned(),
        1 => "1 run working".to_owned(),
        n => format!("{n} runs working"),
    }
}

/// The second status line: stopped, or on duty with the next scheduled run when there is
/// one. A routine started only by a poll or a folder has no next time and is on duty too.
fn duty_line(state: &MenuState, hour_minute: impl Fn(i64) -> String) -> String {
    if state.halted {
        return "All routines stopped".to_owned();
    }
    match &state.next {
        Some(next) => format!("On duty · next {} {}", next.name, hour_minute(next.at_ms)),
        None => "On duty".to_owned(),
    }
}

/// The menu for `state`. `dev`: a development or test run, beside the installed app's item.
fn entries(state: &MenuState, dev: bool, login: LoginItem, hour_minute: impl Fn(i64) -> String) -> Vec<Entry> {
    let mut entries = Vec::new();
    if dev {
        entries.push(Entry::Line("Eos (dev)".to_owned()));
    }
    entries.push(Entry::Line(working_line(state.working)));
    entries.push(Entry::Line(duty_line(state, hour_minute)));
    entries.push(Entry::Separator);
    let needs = if state.needs_you > 0 { format!("Needs you ({})", state.needs_you) } else { "Needs you".to_owned() };
    entries.push(Entry::Command(Action::NeedsYou, needs));
    entries.push(Entry::Command(Action::Open, "Open Eos".to_owned()));
    entries.push(Entry::Separator);
    entries.push(if state.halted {
        Entry::Command(Action::Resume, "Resume".to_owned())
    } else {
        Entry::Command(Action::Halt, "Stop all routines".to_owned())
    });
    entries.push(Entry::Login { checked: login == LoginItem::On, enabled: login != LoginItem::Unavailable });
    entries.push(Entry::Separator);
    entries.push(Entry::Command(Action::Quit, "Quit Eos".to_owned()));
    entries
}

/// The titles, for `--status`.
fn titles(entries: &[Entry]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Line(text) | Entry::Command(_, text) => Some(text.clone()),
            Entry::Login { checked, .. } => Some(format!("Start at Login{}", if *checked { " ✓" } else { "" })),
            Entry::Separator => None,
        })
        .collect()
}

/// The icon's side in pixels: 18 points on a Retina screen.
const SIDE: u32 = 36;

/// The template icon: a ring, open at the top right where a dot sits while Needs you is
/// above zero. Only its alpha counts: the system draws it in the menu bar's color.
fn glyph(dot: bool) -> Vec<u8> {
    let (center, ring, half_width) = (SIDE as f32 / 2.0, 11.0_f32, 1.75_f32);
    let (dot_at, dot_radius, gap) = ((29.0_f32, 7.0_f32), 5.5_f32, 8.5_f32);
    let mut rgba = vec![0u8; (SIDE * SIDE * 4) as usize];
    for y in 0..SIDE {
        for x in 0..SIDE {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let from_dot = ((px - dot_at.0).powi(2) + (py - dot_at.1).powi(2)).sqrt();
            let on_ring = 1.0 - ((((px - center).powi(2) + (py - center).powi(2)).sqrt() - ring).abs() - half_width);
            let coverage = if dot {
                let ring = if from_dot < gap { 0.0 } else { on_ring };
                ring.max(dot_radius + 0.5 - from_dot)
            } else {
                on_ring
            };
            rgba[((y * SIDE + x) * 4 + 3) as usize] = (coverage.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    rgba
}

const ID: &str = "eos";

/// The item: the state it was last handed and the titles it was last drawn with.
#[derive(Debug, Default)]
pub(crate) struct Tray {
    state: Mutex<Option<MenuState>>,
    titles: Mutex<Option<Vec<String>>>,
}

impl Tray {
    /// Keeps `state` for the next drawing.
    pub(crate) fn set(&self, state: MenuState) {
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = Some(state);
    }

    /// Whether the item shows: the Eos preview is on or a routine exists.
    pub(crate) fn shown(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|state| state.shown)
    }

    /// Draws the item for the state last handed in, making it on its first showing, or hides
    /// it; nothing before the first state. Main thread.
    pub(crate) fn draw(&self, app: &tauri::AppHandle, dev: bool, login: LoginItem) -> tauri::Result<()> {
        let Some(state) = self.state.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return Ok(()) };
        if !state.shown {
            if let Some(tray) = app.tray_by_id(ID) {
                tray.set_visible(false)?;
            }
            *self.titles.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return Ok(());
        }
        let hour_minute = |at_ms: i64| eos_platform::local_hour_minute(at_ms).unwrap_or_default();
        let entries = entries(&state, dev, login, hour_minute);
        let menu = menu(app, &entries)?;
        let icon = Image::new_owned(glyph(state.needs_you > 0), SIDE, SIDE);
        match app.tray_by_id(ID) {
            Some(tray) => {
                tray.set_menu(Some(menu))?;
                tray.set_icon_with_as_template(Some(icon), true)?;
                tray.set_visible(true)?;
            }
            None => {
                TrayIconBuilder::with_id(ID)
                    .icon(icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .tooltip("Eos")
                    .build(app)?;
            }
        }
        *self.titles.lock().unwrap_or_else(|p| p.into_inner()) = Some(titles(&entries));
        Ok(())
    }

    /// For `--status`: the menu's titles and where the icon is, or `null` while it is hidden.
    pub(crate) fn status(&self, app: Option<&tauri::AppHandle>) -> serde_json::Value {
        let Some(titles) = self.titles.lock().unwrap_or_else(|p| p.into_inner()).clone() else {
            return serde_json::Value::Null;
        };
        let rect = app.and_then(|app| app.tray_by_id(ID)).and_then(|tray| tray.rect().ok().flatten()).map(|rect| {
            let (position, size) = (rect.position.to_logical::<f64>(1.0), rect.size.to_logical::<f64>(1.0));
            [position.x, position.y, size.width, size.height]
        });
        serde_json::json!({ "items": titles, "rect": rect })
    }
}

fn menu(app: &tauri::AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::DynRuntime>> {
    let mut items: Vec<Box<dyn IsMenuItem<tauri::DynRuntime>>> = Vec::with_capacity(entries.len());
    for entry in entries {
        items.push(match entry {
            Entry::Line(text) => Box::new(MenuItem::new(app, text, false, None::<&str>)?),
            Entry::Command(action, text) => Box::new(MenuItem::with_id(app, action.id(), text, true, None::<&str>)?),
            Entry::Login { checked, enabled } => Box::new(CheckMenuItem::with_id(
                app,
                Action::Login.id(),
                "Start at Login",
                *enabled,
                *checked,
                None::<&str>,
            )?),
            Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        });
    }
    let items: Vec<&dyn IsMenuItem<tauri::DynRuntime>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(_: i64) -> String {
        "05:00".to_owned()
    }

    #[test]
    fn the_status_lines_count_runs_and_name_the_next() {
        assert_eq!(working_line(0), "Nothing running");
        assert_eq!(working_line(1), "1 run working");
        assert_eq!(working_line(2), "2 runs working");
        let next = Some(NextRun { name: "PR Review".into(), at_ms: 0 });
        let state = MenuState { next, ..MenuState::default() };
        assert_eq!(duty_line(&state, at), "On duty · next PR Review 05:00");
        assert_eq!(duty_line(&MenuState::default(), at), "On duty", "a routine started by a poll has no next time");
        let stopped = MenuState { halted: true, ..state };
        assert_eq!(duty_line(&stopped, at), "All routines stopped");
    }

    #[test]
    fn the_menu_offers_what_the_state_allows() {
        let state = MenuState { working: 2, needs_you: 3, ..MenuState::default() };
        let shown = titles(&entries(&state, false, LoginItem::On, at));
        assert_eq!(
            shown,
            [
                "2 runs working",
                "On duty",
                "Needs you (3)",
                "Open Eos",
                "Stop all routines",
                "Start at Login ✓",
                "Quit Eos"
            ]
        );
        let halted = MenuState { halted: true, ..MenuState::default() };
        let shown = titles(&entries(&halted, true, LoginItem::Off, at));
        assert_eq!(
            shown,
            [
                "Eos (dev)",
                "Nothing running",
                "All routines stopped",
                "Needs you",
                "Open Eos",
                "Resume",
                "Start at Login",
                "Quit Eos"
            ]
        );
        let login = entries(&halted, false, LoginItem::Unavailable, at);
        assert!(login.contains(&Entry::Login { checked: false, enabled: false }), "a dev run cannot be a login item");
    }

    #[test]
    fn every_command_is_found_by_its_id() {
        for action in [Action::NeedsYou, Action::Open, Action::Halt, Action::Resume, Action::Login, Action::Quit] {
            assert_eq!(Action::from_id(action.id()), Some(action));
        }
        assert_eq!(Action::from_id("quit"), None, "the app menu's Quit is not the item's");
    }

    #[test]
    fn the_dot_shows_only_with_something_waiting() {
        let (plain, dotted) = (glyph(false), glyph(true));
        let alpha = |rgba: &[u8], x: u32, y: u32| rgba[((y * SIDE + x) * 4 + 3) as usize];
        assert_eq!(alpha(&plain, 29, 7), 0);
        assert_eq!(alpha(&dotted, 29, 7), 255);
        assert_eq!(alpha(&plain, 18, 29), alpha(&dotted, 18, 29), "the ring's bottom is the same");
        assert_eq!(alpha(&plain, 18, 29), 255);
    }
}
