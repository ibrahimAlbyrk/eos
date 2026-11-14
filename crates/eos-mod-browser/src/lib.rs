//! The browser: tabs in the side panel that the user and agents both drive.
//!
//! A tab is a view of the app's own window (the shell's [`BrowserViews`] port), driven over
//! its in-process DevTools channel; there is no separate browser process and no socket.
//!
//! - [`axtree`], [`keys`], [`policy`]: the pure rules (the snapshot text and its refs, key
//!   chords, where an agent may navigate, storage names), each checked against vectors made
//!   by today's TypeScript (`fixtures/browser`).
//! - `driver`: tabs and the verbs on them.
//! - [`BrowserService`]: sessions, "this page", the tab list and status as events.
//! - [`Desk`]: the routes (`/browser/*`) and the agent tools ([`BrowserTools`]) over it.
//!
//! # What may reach the local network
//!
//! Pages are kept off the local network by the shell. A navigation someone asked for may go
//! there: an address the user typed, an address an agent's `browser_navigate` or
//! `browser_new_tab` named (agents open dev servers on `localhost` all the time), and back,
//! forward or reload chosen by either. The driver tells the view before such a navigation
//! ([`BrowserViews::allow_local_network`]). What a page starts itself is never asked for: a
//! redirect, a link, a script's navigation, and a popup (which becomes a tab without that
//! call). The opening is the view's profile's, for as long as the view stays on the local
//! network; an agent is first held to `browser.allowedOrigins` like everywhere else.
//!
//! # Storage, and the logins of the app before this one
//!
//! Each session's tabs share one storage, named `browser-<session>` (`browser-profile` for
//! the global one), kept by Chromium under the shell's own data folder. The Electron app
//! kept its panel logins in its own partitions and a headless Chrome's under
//! `<home>/browser/`; neither can be read by this Chromium (another version's profile,
//! cookies encrypted with another Keychain item). Those folders are user data: they are
//! left exactly where they are, never opened, copied or removed, and the user signs in
//! again in the new panel.

#![cfg_attr(test, allow(clippy::unwrap_used))]

mod axtree;
mod driver;
mod keys;
mod policy;
mod routes;
mod service;

use std::sync::Arc;

use eos_contracts::builtin_plugins::ids as plugins;
use eos_contracts::{BrowserActivity, BrowserElement, BrowserStatus};
use eos_core::browser::{BrowserTools, ElementPicker};
use eos_core::os::FileSystem;
use eos_core::shell::{BrowserPanel, BrowserViews};
use eos_core::store::{ConfigSource, Store};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_runtime::bus::{Bus, Topic, TopicDecl};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub use axtree::{FormatOptions, Formatted, format_ax_tree, is_focusable, role_of, states_of};
pub use driver::DriverError;
pub use keys::{KeyChord, parse_chord};
pub use policy::{Actor, check_navigation, host_of, profile_key, profile_name, redact_for_agent, redact_headers};
pub use routes::{Caller, Desk};
pub use service::{Acted, BrowserService, Error, NEW_TAB_URL, PRESENT_RATE_LIMIT_MS, TabsChanged};

/// A session's tab list changed.
pub const BROWSER_TABS: Topic<TabsChanged> = Topic::new("browser:tabs");
/// An agent opened or loaded a page, or presented one.
pub const BROWSER_ACTIVITY: Topic<BrowserActivity> = Topic::new("browser:activity");
/// A session's browser started or ended.
pub const BROWSER_STATUS: Topic<BrowserStatus> = Topic::new("browser:status");

/// What the browser is built from.
pub struct Ports {
    /// The shell's views and the dashboard's panel; `None` without a window (tests, a
    /// headless run): the browser is then absent.
    pub shell: Option<(Arc<dyn BrowserViews>, Arc<dyn BrowserPanel>)>,
    pub config: Arc<dyn ConfigSource>,
    /// The database: the worker rows that say which session an agent belongs to, and the
    /// timeline.
    pub store: Arc<dyn Store>,
    /// Where captures are written for an agent to read.
    pub files: Arc<dyn FileSystem>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub bus: Bus,
}

impl std::fmt::Debug for Ports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ports").field("shell", &self.shell.is_some()).finish_non_exhaustive()
    }
}

pub struct BrowserModule {
    desk: Arc<Desk>,
}

impl std::fmt::Debug for BrowserModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserModule").finish_non_exhaustive()
    }
}

impl BrowserModule {
    pub fn new(ports: Ports) -> Self {
        let (driver, panel) = match ports.shell {
            Some((views, panel)) => {
                (Some(driver::Driver::new(views, Some(panel.clone()), ports.sleeper.clone())), Some(panel))
            }
            None => (None, None),
        };
        let browser = BrowserService::new(driver, ports.config, ports.bus, ports.clock.clone(), ports.sleeper);
        if let Some(panel) = panel {
            panel.listen(browser.clone());
        }
        Self { desk: Arc::new(Desk::new(browser, ports.store, ports.files, ports.clock)) }
    }

    /// The browser for the agent tools.
    pub fn tools(&self) -> Arc<dyn BrowserTools> {
        self.desk.clone()
    }

    /// The panel's element picker, for the shell's bridge.
    pub fn element_picker(&self) -> Arc<dyn ElementPicker> {
        Arc::new(Picker(self.desk.browser.clone()))
    }

    pub fn service(&self) -> &Arc<BrowserService> {
        &self.desk.browser
    }
}

struct Picker(Arc<BrowserService>);

impl ElementPicker for Picker {
    fn pick<'a>(&'a self, tab_id: &'a str) -> BoxFuture<'a, Option<BrowserElement>> {
        Box::pin(self.0.pick_element(tab_id))
    }

    fn cancel(&self) {
        self.0.cancel_pick();
    }
}

impl Module for BrowserModule {
    fn id(&self) -> &'static str {
        "browser"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(plugins::BROWSER)
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.desk)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![BROWSER_TABS.decl(), BROWSER_ACTIVITY.decl(), BROWSER_STATUS.decl()]
    }

    fn on_session_ended(&self, session_key: &str) {
        self.desk.browser.end_session(session_key);
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.desk.browser.dispose())
    }
}
