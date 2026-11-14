//! The app menu. On a Mac its accelerators own ⌘C/⌘V/⌘Z, so the Edit commands are routed
//! here: to the dashboard's own logic (composer stack, terminal) when the dashboard has the
//! keyboard, to the embedded view that has it otherwise.

use eos_bridge::EditCommand;
use eos_bridge::hosts::MachineItem;
use tauri::menu::{AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

/// What a menu item asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Command {
    Edit(EditCommand),
    Reload,
    DevTools,
    ConnectMachine,
    /// Show this computer (`None`) or a controlled one.
    Machine(Option<String>),
    Quit,
}

const MACHINE: &str = "machine:";
const THIS_MACHINE: &str = "machine:this";

impl Command {
    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "reload" => Command::Reload,
            "devtools" => Command::DevTools,
            "connect-machine" => Command::ConnectMachine,
            THIS_MACHINE => Command::Machine(None),
            "quit" => Command::Quit,
            other if other.starts_with(MACHINE) => Command::Machine(Some(other[MACHINE.len()..].to_owned())),
            other => Command::Edit(EditCommand::parse(other.strip_prefix("edit:")?)?),
        })
    }
}

/// The app menu; `machines` are the Machines menu's computers.
pub(crate) fn build(
    app: &tauri::AppHandle,
    name: &str,
    version: &str,
    machines: &[MachineItem],
) -> tauri::Result<Menu<tauri::DynRuntime>> {
    let item = |id: &str, text: &str, accelerator: &str| MenuItem::with_id(app, id, text, true, Some(accelerator));
    let separator = || PredefinedMenuItem::separator(app);

    let about =
        AboutMetadata { name: Some(name.to_string()), version: Some(version.to_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            // Not the predefined item: quitting must run the app's shutdown first.
            &item("quit", &format!("Quit {name}"), "CmdOrCtrl+Q")?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item("edit:undo", "Undo", "CmdOrCtrl+Z")?,
            &item("edit:redo", "Redo", "Shift+CmdOrCtrl+Z")?,
            &separator()?,
            &item("edit:cut", "Cut", "CmdOrCtrl+X")?,
            &item("edit:copy", "Copy", "CmdOrCtrl+C")?,
            &item("edit:paste", "Paste", "CmdOrCtrl+V")?,
            &item("edit:selectAll", "Select All", "CmdOrCtrl+A")?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("reload", "Reload", "CmdOrCtrl+R")?,
            &item("devtools", "Toggle Developer Tools", "Alt+CmdOrCtrl+I")?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let computers = machines
        .iter()
        .map(|m| {
            let id = m.id.as_ref().map_or_else(|| THIS_MACHINE.to_owned(), |id| format!("{MACHINE}{id}"));
            CheckMenuItem::with_id(app, id, &m.label, true, m.checked, Some(m.accelerator.as_str()))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let (separator_item, connect) =
        (separator()?, MenuItem::with_id(app, "connect-machine", "Connect a Machine…", true, None::<&str>)?);
    let mut items: Vec<&dyn IsMenuItem<tauri::DynRuntime>> =
        computers.iter().map(|c| c as &dyn IsMenuItem<tauri::DynRuntime>).collect();
    if !items.is_empty() {
        items.push(&separator_item);
    }
    items.push(&connect);
    let machines = Submenu::with_items(app, "Machines", true, &items)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &machines, &window])
}
