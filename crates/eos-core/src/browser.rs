//! What the browser feature offers the rest of the app: the browser as an agent's
//! `browser_*` tools drive it, and the element picker of the dashboard's panel.

use eos_contracts::{
    BrowserActRequest, BrowserElement, BrowserFillFormRequest, BrowserFindRequest, BrowserGetRequest,
    BrowserMuteRequest, BrowserNavigateRequest, BrowserNewTabRequest, BrowserPressRequest, BrowserScreenshotRequest,
    BrowserScrollRequest, BrowserShowRequest, BrowserSnapshotRequest, BrowserTypeRequest, BrowserWaitRequest,
};
use serde_json::Value;

use crate::BoxFuture;

/// One thing an agent asks of the browser. Each is what one tool sends today, with the tab
/// it acts on already chosen: a tool whose `tabId` was left out asks for
/// [`ActiveTab`](BrowserCall::ActiveTab) first, as `resolveTabId` does. The `tab_id` field
/// inside a request is not read.
#[derive(Debug, Clone, PartialEq)]
pub enum BrowserCall {
    /// The tab an omitted `tabId` means: `{ "tabId": … }`, or 409 `no active tab`.
    ActiveTab,
    /// `browser_tabs`
    Tabs,
    /// `browser_new_tab`
    NewTab(BrowserNewTabRequest),
    /// `browser_close_tab`
    CloseTab { tab_id: String },
    /// `browser_navigate`
    Navigate { tab_id: String, request: BrowserNavigateRequest },
    /// `browser_snapshot`
    Snapshot { tab_id: String, request: BrowserSnapshotRequest },
    /// `browser_find`
    Find { tab_id: String, request: BrowserFindRequest },
    /// `browser_act`
    Act { tab_id: String, request: BrowserActRequest },
    /// `browser_type`
    Type { tab_id: String, request: BrowserTypeRequest },
    /// `browser_fill_form`
    FillForm { tab_id: String, request: BrowserFillFormRequest },
    /// `browser_press`
    Press { tab_id: String, request: BrowserPressRequest },
    /// `browser_scroll`
    Scroll { tab_id: String, request: BrowserScrollRequest },
    /// `browser_get`
    Get { tab_id: String, request: BrowserGetRequest },
    /// `browser_wait`
    Wait { tab_id: String, request: BrowserWaitRequest },
    /// `browser_screenshot`: answers `{ "path": … }`, a JPEG file for the agent to read.
    Screenshot { tab_id: String, request: BrowserScreenshotRequest },
    /// `browser_show`: the tab named in the request, else the session's active tab.
    Show(BrowserShowRequest),
    /// `browser_mute`
    Mute { tab_id: String, request: BrowserMuteRequest },
}

/// A refused or failed call: the status and `error` text the browser routes answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BrowserError {
    pub status: u16,
    pub message: String,
}

/// The browser for the agent tools. A call answers the JSON the browser routes answer the
/// same agent: its session's browser, the same fences (another session's tab, the origin
/// allowlist), the same timeline events, the same errors.
pub trait BrowserTools: Send + Sync + 'static {
    fn call<'a>(&'a self, agent_id: &'a str, call: BrowserCall) -> BoxFuture<'a, Result<Value, BrowserError>>;
}

/// The panel's "pick an element" mode: Chromium's own inspect overlay on the live view.
pub trait ElementPicker: Send + Sync + 'static {
    /// Resolves with the element the user clicked; `None` when the pick was cancelled, the
    /// tab is unknown or the overlay could not start. One pick at a time: a new one cancels
    /// the one before it.
    fn pick<'a>(&'a self, tab_id: &'a str) -> BoxFuture<'a, Option<BrowserElement>>;

    /// Ends a pick that is under way.
    fn cancel(&self);
}
