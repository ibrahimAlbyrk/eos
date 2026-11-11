//! Port of `contracts/src/builtin-plugins.ts`: features that ship with Eos
//! but are switched on and off like any plugin (Settings › Plugins).
//!
//! Turning one off removes it everywhere: its UI, its routes (they answer
//! "turned off") and, for sessions started after, its agent tools and prompt
//! section. Its data stays.

use crate::plugin::{PluginId, PluginManifest};

/// Ids of built-ins start with this; plugin folders may not use it.
pub const BUILTIN_PLUGIN_PREFIX: &str = "eos.";

pub mod ids {
    pub const PAGES: &str = "eos.pages";
    pub const BTW: &str = "eos.btw";
    pub const ARTIFACTS: &str = "eos.artifacts";
    pub const BROWSER: &str = "eos.browser";
    pub const AUTO_NAME: &str = "eos.auto-name";
    pub const TERMINAL: &str = "eos.terminal";
    /// Built like a plugin but a core feature: always on, never listed (no manifest).
    pub const ARCHIVE: &str = "eos.archive";
}

const SVG: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6""#;
const ROUND: &str = r#" stroke-linecap="round" stroke-linejoin="round""#;

/// `(id, name, description, rounded strokes, icon paths)`, in listing order.
const MANIFESTS: &[(&str, &str, &str, bool, &str)] = &[
    (
        ids::PAGES,
        "Pages",
        "Markdown notes and task lists you and your agents write together, in the side panel.",
        true,
        r#"<path d="M6 3.5h7.8L18 7.7v12.8H6z"/><path d="M13.5 3.5v4.5H18M9 12.5h6M9 16h4"/>"#,
    ),
    (
        ids::BTW,
        "Side question",
        "Ask the agent a quick question with /btw (⌘/) without adding to the chat.",
        true,
        r#"<path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.6-4.1A8 8 0 1 1 20 11.5Z"/><path d="M10 9.3a2 2 0 1 1 2.8 1.9c-.6.3-.8.7-.8 1.3v.3M12 15.5h.01"/>"#,
    ),
    (
        ids::ARTIFACTS,
        "Artifacts",
        "Your claude.ai artifacts in the side panel — opened, previewed and listed for every Claude sign-in.",
        false,
        r#"<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M4 9h16"/>"#,
    ),
    (
        ids::BROWSER,
        "Browser",
        "A browser in the side panel that you and your agents can both drive.",
        false,
        r#"<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.7" ry="8.5"/><path d="M3.8 9h16.4M3.8 15h16.4"/>"#,
    ),
    (
        ids::AUTO_NAME,
        "Auto-name",
        "Names a new chat after its first request.",
        true,
        r#"<path d="M4 7V5h16v2M12 5v14M9 19h6"/>"#,
    ),
    (
        ids::TERMINAL,
        "Terminal",
        "Shells in the side panel (⌃`).",
        true,
        r#"<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 9.5 3.5 3-3.5 3M12.5 15.5h5"/>"#,
    ),
];

/// The manifests Settings › Plugins lists for the built-ins.
pub fn builtin_plugin_manifests() -> Vec<PluginManifest> {
    MANIFESTS
        .iter()
        .map(|(id, name, description, round, paths)| PluginManifest {
            id: PluginId((*id).to_owned()),
            name: (*name).to_owned(),
            description: Some((*description).to_owned()),
            version: None,
            icon: Some(format!("{SVG}{}>{paths}</svg>", if *round { ROUND } else { "" })),
            ui: None,
            settings: None,
            experimental: None,
        })
        .collect()
}

/// The prompt-assembly fact a turned-off built-in sets for sessions started
/// while it is off.
pub fn plugin_off_fact(id: &str) -> String {
    format!("plugin-off:{id}")
}
