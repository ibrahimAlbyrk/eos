//! The browser in the side panel, as an agent drives it (the `browser_*`
//! tools). Every tool is one call on the browser feature; a tool whose
//! `tabId` is left out acts on the tab the panel shows.

use std::sync::Arc;

use eos_contracts::builtin_plugins::ids::BROWSER;
use eos_core::BoxFuture;
use eos_core::browser::{BrowserCall, BrowserTools};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::schema::{Schema, array, boolean, int, object, one_of, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

/// There is no first-tab fallback: acting on a tab the user is not looking at
/// is worse than a clear failure.
const NO_ACTIVE_TAB: &str = "no active tab — the browser panel is not viewing any tab; open one with browser_new_tab, focus a tab in the panel, or pass an explicit tabId";

/// How a tool's checked input becomes its call.
type Build = fn(String, Value) -> Result<BrowserCall, Failure>;

enum Target {
    /// Acts on one tab: the one named, else the panel's.
    Tab(Build),
    /// Names no tab, or resolves it on the browser's side.
    Any(fn(Value) -> Result<BrowserCall, Failure>),
}

struct BrowserTool {
    browser: Arc<dyn BrowserTools>,
    target: Target,
}

async fn tab_id(browser: &dyn BrowserTools, agent: &str, input: &Value) -> Result<String, Failure> {
    if let Some(given) = input.get("tabId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
        return Ok(given.to_owned());
    }
    // A refusal here means the panel shows no tab: the hint says what to do.
    let active = browser.call(agent, BrowserCall::ActiveTab).await.ok();
    active
        .as_ref()
        .and_then(|found| found.get("tabId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| Failure(NO_ACTIVE_TAB.to_owned()))
}

impl Handler for BrowserTool {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let request = match &self.target {
                Target::Tab(build) => {
                    let tab = tab_id(self.browser.as_ref(), call.self_id, &input).await?;
                    build(tab, input)?
                }
                Target::Any(build) => build(input)?,
            };
            match self.browser.call(call.self_id, request).await {
                Ok(Value::String(text)) => Ok(Output::Text(text)),
                Ok(answer) => Ok(Output::Json(answer)),
                Err(e) => Err(Failure::refused(e.status, &e.message)),
            }
        })
    }
}

fn request<T: DeserializeOwned>(input: Value) -> Result<T, Failure> {
    args(input)
}

fn tab(what: &str) -> Schema {
    string().optional().describe(format!("Tab to {what}; omit for the active tab"))
}

fn spec(browser: &Arc<dyn BrowserTools>, name: &'static str, input: Schema, target: Target) -> Spec {
    Spec::new(name, input, BrowserTool { browser: browser.clone(), target }).plugin(BROWSER)
}

pub(crate) fn specs(b: &Arc<dyn BrowserTools>) -> Vec<Spec> {
    vec![
        spec(
            b,
            "browser_navigate",
            object(vec![
                ("tabId", tab("drive")),
                (
                    "action",
                    one_of(&["url", "back", "forward", "reload"])
                        .describe("\"url\" loads `url`; back/forward walk history; reload refreshes"),
                ),
                ("url", string().optional().describe("Target URL — required when action is \"url\"")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Navigate { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_snapshot",
            object(vec![
                ("tabId", tab("read")),
                (
                    "interactiveOnly",
                    boolean()
                        .default(json!(true))
                        .describe("Only interactive elements (buttons, links, inputs) — keeps the tree small"),
                ),
                ("selector", string().optional().describe("Scope the tree to a CSS-selector subtree")),
                ("depth", int().positive().optional().describe("Limit tree depth")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Snapshot { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_find",
            object(vec![
                ("tabId", tab("search")),
                ("query", string().describe("Visible text to match, or /regex/ between slashes")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Find { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_act",
            object(vec![
                ("tabId", tab("act on")),
                ("ref", string().describe("Element ref (@eN) from browser_snapshot or browser_find")),
                (
                    "verb",
                    one_of(&["click", "hover", "focus", "check", "uncheck"]).describe("What to do to the element"),
                ),
                (
                    "includeSnapshot",
                    boolean().default(json!(false)).describe(
                        "Return a fresh snapshot with the result (token-expensive — request only when you need to see the outcome)",
                    ),
                ),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Act { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_type",
            object(vec![
                ("tabId", tab("act on")),
                ("ref", string().describe("Element ref (@eN) of the input to type into")),
                ("text", string().describe("Text to type")),
                ("submit", boolean().default(json!(false)).describe("Press Enter after typing")),
                (
                    "includeSnapshot",
                    boolean()
                        .default(json!(false))
                        .describe("Return a fresh snapshot with the result (token-expensive)"),
                ),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Type { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_fill_form",
            object(vec![
                ("tabId", tab("act on")),
                (
                    "fields",
                    array(object(vec![
                        ("ref", string().describe("Element ref (@eN) of the field")),
                        ("value", string().describe("Value to fill in")),
                    ]))
                    .describe("Fields to fill, in order"),
                ),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::FillForm { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_press",
            object(vec![
                ("tabId", tab("act on")),
                ("key", string().describe("Key or chord: \"Enter\", \"Tab\", \"Escape\", \"Control+a\"")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Press { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_scroll",
            object(vec![
                ("tabId", tab("scroll")),
                (
                    "direction",
                    one_of(&["up", "down", "top", "bottom"])
                        .describe("up/down = one viewport; top/bottom = jump to the edge"),
                ),
                ("ref", string().optional().describe("Scroll this container instead of the page")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Scroll { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_wait",
            object(vec![
                ("tabId", tab("watch")),
                (
                    "forText",
                    string().optional().describe("Wait until this text appears on the page (substring)"),
                ),
                ("forRef", string().optional().describe("Wait until this element ref (@eN) is visible")),
                ("forMs", int().positive().optional().describe("Wait a fixed number of milliseconds")),
                ("timeoutMs", int().positive().default(json!(15000)).describe("Give up after this long")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Wait { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_get",
            object(vec![
                ("tabId", tab("read")),
                (
                    "what",
                    one_of(&["text", "url", "title", "value"]).describe(
                        "\"url\"/\"title\" are page-level; \"text\"/\"value\" read one element and need `ref`",
                    ),
                ),
                (
                    "ref",
                    string().optional().describe("Element ref (@eN) — required for \"text\" and \"value\""),
                ),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Get { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_screenshot",
            object(vec![
                ("tabId", tab("capture")),
                (
                    "fullPage",
                    boolean().default(json!(false)).describe("Capture the whole page, not just the viewport"),
                ),
            ]),
            // Answers a file's path: the picture itself never rides the result.
            Target::Tab(|tab_id, input| Ok(BrowserCall::Screenshot { tab_id, request: request(input)? })),
        ),
        spec(b, "browser_tabs", object(vec![]), Target::Any(|_| Ok(BrowserCall::Tabs))),
        spec(
            b,
            "browser_new_tab",
            object(vec![(
                "url",
                string().optional().describe("URL to open the tab at; omit for the default start page"),
            )]),
            Target::Any(|input| Ok(BrowserCall::NewTab(request(input)?))),
        ),
        spec(
            b,
            "browser_close_tab",
            object(vec![(
                "tabId",
                string().optional().describe(
                    "Tab to close; omit for the active tab — pass it explicitly when several are open",
                ),
            )]),
            Target::Tab(|tab_id, _| Ok(BrowserCall::CloseTab { tab_id })),
        ),
        spec(
            b,
            "browser_mute",
            object(vec![
                ("tabId", tab("mute")),
                ("muted", boolean().describe("true silences the tab, false restores audio")),
            ]),
            Target::Tab(|tab_id, input| Ok(BrowserCall::Mute { tab_id, request: request(input)? })),
        ),
        spec(
            b,
            "browser_show",
            object(vec![(
                "tabId",
                string().optional().describe("Tab to present; omit for your session's active tab"),
            )]),
            Target::Any(|input| Ok(BrowserCall::Show(request(input)?))),
        ),
    ]
}
