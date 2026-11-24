//! The quick panel's global shortcut (07 §4.3): ⌥Space, or the user's own, else ⌃⌥Space when
//! the first is taken. `global-hotkey` registers it through Carbon's `RegisterEventHotKey`,
//! which needs no permission. Only the app that owns the doors registers one: a dev or test
//! run never takes a key from the user's Mac.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eos_bridge::Shortcut;
use eos_bridge::doors::{self, shortcut_problem};
use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::log::log;

thread_local! {
    /// The manager lives on the main thread, where Carbon delivers its events.
    static MANAGER: RefCell<Option<GlobalHotKeyManager>> = const { RefCell::new(None) };
}

#[derive(Debug)]
struct Held {
    /// The registered key and its accelerator.
    key: Option<(HotKey, String)>,
    shortcut: Shortcut,
}

pub(crate) struct Hotkeys {
    data_dir: PathBuf,
    held: Arc<Mutex<Held>>,
}

impl Hotkeys {
    /// Registers the shortcut and calls `pressed` on each press. Main thread.
    pub(crate) fn start(data_dir: PathBuf, pressed: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        let empty = Shortcut { accelerator: doors::SHORTCUT.to_owned(), held: false, problem: None };
        let hotkeys = Arc::new(Hotkeys { data_dir, held: Arc::new(Mutex::new(Held { key: None, shortcut: empty })) });
        match GlobalHotKeyManager::new() {
            Ok(manager) => MANAGER.with(|slot| *slot.borrow_mut() = Some(manager)),
            Err(e) => {
                log("doors", &format!("no global shortcut: {e}"));
                return hotkeys;
            }
        }
        let held = hotkeys.held.clone();
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            let ours =
                held.lock().unwrap_or_else(|p| p.into_inner()).key.as_ref().is_some_and(|(k, _)| k.id() == event.id());
            if ours && event.state() == HotKeyState::Pressed {
                pressed();
            }
        }));
        let order = doors::shortcut_order(&hotkeys.data_dir);
        let asked = order[0].clone();
        let holding = order.iter().find(|accelerator| hotkeys.register(accelerator)).cloned();
        hotkeys.settle(&asked, holding.as_deref());
        hotkeys
    }

    /// The shortcut as it holds now.
    pub(crate) fn state(&self) -> Shortcut {
        self.lock().shortcut.clone()
    }

    /// Registers `accelerator` in place of the one held, remembering it when it holds; the one
    /// held stays when it does not. Main thread.
    pub(crate) fn set(&self, accelerator: &str) -> Shortcut {
        let was = self.lock().key.clone();
        if was.as_ref().is_some_and(|(_, held)| held == accelerator) {
            return self.state();
        }
        if let Some((key, _)) = &was {
            MANAGER.with(|slot| slot.borrow().as_ref().map(|m| m.unregister(*key)));
            self.lock().key = None;
        }
        if self.register(accelerator) {
            if let Err(e) = doors::set_shortcut(&self.data_dir, accelerator) {
                log("doors", &format!("the shortcut was not remembered: {e}"));
            }
            self.settle(accelerator, Some(accelerator));
        } else {
            let back = was.and_then(|(_, held)| self.register(&held).then_some(held));
            self.settle(accelerator, back.as_deref());
        }
        self.state()
    }

    /// Registers one accelerator; whether the system gave it to Eos. Main thread.
    fn register(&self, accelerator: &str) -> bool {
        let Ok(key) = accelerator.parse::<HotKey>() else { return false };
        let done = MANAGER.with(|slot| slot.borrow().as_ref().map(|m| m.register(key)));
        match done {
            Some(Ok(())) => {
                self.lock().key = Some((key, accelerator.to_owned()));
                true
            }
            _ => false,
        }
    }

    /// Records what holds: `holding` after `asked` was asked for.
    fn settle(&self, asked: &str, holding: Option<&str>) {
        let shortcut = Shortcut {
            accelerator: holding.unwrap_or(asked).to_owned(),
            held: holding.is_some(),
            problem: shortcut_problem(asked, holding),
        };
        let words = if shortcut.held { "holds" } else { "does not hold" };
        log(
            "doors",
            &format!("the quick panel's shortcut {}: {}", words, doors::shortcut_words(&shortcut.accelerator)),
        );
        self.lock().shortcut = shortcut;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|p| p.into_inner())
    }
}
