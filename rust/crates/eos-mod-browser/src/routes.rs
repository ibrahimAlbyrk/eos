//! The browser routes (`manager/modules/browser/routes.ts`), and the same calls for the
//! agent tools.
//!
//! Who is calling is read from what the request proves, never from its body: the user's own
//! window drives the session it names with `?session=` and is never fenced; anything else is
//! an agent, named by `x-eos-agent-id`, driving its own session's browser under the origin
//! allowlist. A tab of another session is refused.
//!
//! Errors: the browser switched off, an agent nobody can name, a ref from before the page
//! changed → 409; a refused navigation, another session's tab → 403; an unknown tab → 404.

use std::sync::Arc;

use eos_contracts::{
    BrowserActRequest, BrowserActivity, BrowserActivityKind, BrowserDeviceRequest, BrowserElementQuery,
    BrowserFillFormRequest, BrowserFindRequest, BrowserGetRequest, BrowserGetRequestWhat, BrowserMuteRequest,
    BrowserNavigateRequest, BrowserNavigateRequestAction, BrowserNewTabRequest, BrowserPressRequest,
    BrowserScreenshotRequest, BrowserScrollRequest, BrowserShowRequest, BrowserSnapshotRequest, BrowserTypeRequest,
    BrowserWaitRequest, GLOBAL_SESSION, Validate, WorkerEventType,
};
use eos_core::Clock;
use eos_core::browser::{BrowserCall, BrowserError, BrowserTools};
use eos_core::os::FileSystem;
use eos_core::store::{Store, agent_caller};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::driver::DriverError;
use crate::policy::{Actor, redact_for_agent};
use crate::service::{BrowserService, Error};

const UNATTRIBUTED: &str = "unattributed agent call — x-eos-agent-id missing or unknown";
const NO_ACTIVE_TAB: &str = "no active tab";

/// Who a request is from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub actor: Actor,
    /// The session whose browser it drives.
    pub session: String,
    /// The agent the timeline and the activity signal name; `None` for the user and for an
    /// agent nobody could name while every session shares one browser.
    pub agent_id: Option<String>,
}

/// The browser behind its routes and behind the agent tools.
pub struct Desk {
    pub(crate) browser: Arc<BrowserService>,
    store: Arc<dyn Store>,
    files: Arc<dyn FileSystem>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for Desk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Desk").finish_non_exhaustive()
    }
}

/// What a call answers: the status and the JSON body.
type Answer = Result<(u16, Value), ApiError>;

fn ok<T: Serialize>(caller: &Caller, payload: &T) -> Answer {
    let value = serde_json::to_value(payload).map_err(|e| ApiError::Internal(e.to_string()))?;
    // Agents get every answer through the redaction; the user's window gets it as it is.
    Ok((200, if caller.actor == Actor::Agent { redact_for_agent(value) } else { value }))
}

fn refused(status: u16, message: &str) -> ApiError {
    ApiError::status_with(status, message)
}

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let message = error.to_string();
        match error {
            Error::Disabled | Error::Driver(DriverError::StaleRef(_)) => ApiError::Conflict(message),
            Error::NavBlocked(_) => ApiError::PermissionDenied(message),
            Error::Driver(DriverError::UnknownTab(_)) => ApiError::NotFound(message),
            Error::Driver(DriverError::Failed(_)) => ApiError::Internal(message),
        }
    }
}

/// A body as the contract type `T`, checked against its rules.
fn parse<T: DeserializeOwned + Validate>(body: &Value) -> Result<T, ApiError> {
    let kind = match body {
        Value::Object(_) => return Ok(eos_contracts::parse(body)?),
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
    };
    Err(ApiError::invalid([("", format!("Expected object, received {kind}"))]))
}

impl Desk {
    pub(crate) fn new(
        browser: Arc<BrowserService>,
        store: Arc<dyn Store>,
        files: Arc<dyn FileSystem>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { browser, store, files, clock }
    }

    /// Who is calling: `user` is whether the request carries the user's own authority,
    /// `agent_header` the value of `x-eos-agent-id`, `session` the `?session=` the user's
    /// window declares (an agent's is ignored: its id decides).
    pub async fn caller(
        &self,
        user: bool,
        agent_header: Option<&str>,
        session: Option<&str>,
    ) -> Result<Caller, ApiError> {
        if user {
            let session = session.filter(|s| !s.is_empty()).unwrap_or(GLOBAL_SESSION).to_owned();
            return Ok(Caller { actor: Actor::Human, session, agent_id: None });
        }
        let header = agent_header.map(str::to_owned);
        let agent = self.store.read(move |tx| agent_caller(tx.workers(), header.as_deref())).await?;
        match agent {
            Some(agent) => Ok(Caller { actor: Actor::Agent, session: agent.session, agent_id: Some(agent.id) }),
            // A call nobody can attribute must not land in someone's session.
            None if self.browser.per_session() => Err(refused(409, UNATTRIBUTED)),
            None => Ok(Caller { actor: Actor::Agent, session: GLOBAL_SESSION.to_owned(), agent_id: None }),
        }
    }

    /// A tab of another session is refused; an unknown one goes on to its 404.
    fn fence(&self, caller: &Caller, tab_id: &str) -> Result<(), ApiError> {
        match self.browser.session_of_tab(tab_id) {
            Some(owner) if owner != self.browser.resolve_session_key(&caller.session) => {
                Err(refused(403, "tab belongs to another session"))
            }
            _ => Ok(()),
        }
    }

    async fn timeline(&self, agent_id: &str, payload: Value) {
        let (agent_id, now) = (agent_id.to_owned(), self.clock.now_ms());
        let appended = self
            .store
            .write(move |tx, _out| tx.events().append_json(&agent_id, now, WorkerEventType::BrowserAction, &payload))
            .await;
        if let Err(error) = appended {
            tracing::warn!(%error, "a browser action was not recorded on the timeline");
        }
    }

    /// An agent opened a tab or loaded a page: the signal the panel opens on, and the
    /// timeline row. Clicks, typing and scrolling never emit; the user's own calls never do.
    async fn used(&self, caller: &Caller, tab_id: &str, verb: &str, url: Option<&str>) {
        let (Actor::Agent, Some(agent_id)) = (caller.actor, &caller.agent_id) else { return };
        let url = url.filter(|u| !u.is_empty());
        self.browser.publish_activity(BrowserActivity {
            session_id: caller.session.clone(),
            worker_id: agent_id.clone(),
            kind: BrowserActivityKind::Use,
            tab_id: tab_id.to_owned(),
            url: url.map(str::to_owned),
        });
        let mut payload = json!({ "tabId": tab_id, "verb": verb });
        if let Some(url) = url {
            payload["url"] = json!(url);
        }
        self.timeline(agent_id, payload).await;
    }

    // ---- the calls, one per route ---------------------------------------------------------

    pub async fn status(&self, caller: &Caller) -> Answer {
        ok(caller, &self.browser.status(&caller.session))
    }

    pub async fn launch(&self, caller: &Caller) -> Answer {
        self.browser.ensure_launched(&caller.session).await?;
        ok(caller, &self.browser.status(&caller.session))
    }

    pub async fn tabs(&self, caller: &Caller) -> Answer {
        let tabs = self.browser.list_tabs(&caller.session).await?;
        ok(caller, &json!({ "tabs": tabs, "sessionId": self.browser.resolve_session_key(&caller.session) }))
    }

    pub async fn active_tab(&self, caller: &Caller) -> Answer {
        match self.browser.active_tab_id(&caller.session)? {
            Some(tab_id) => ok(caller, &json!({ "tabId": tab_id })),
            None => Err(refused(409, NO_ACTIVE_TAB)),
        }
    }

    pub async fn new_tab(&self, caller: &Caller, body: &Value) -> Answer {
        let request: BrowserNewTabRequest = parse(body)?;
        let tab_id = self.browser.open_tab(request.url.as_deref(), caller.actor, &caller.session).await?;
        self.used(caller, &tab_id, "new_tab", request.url.as_deref()).await;
        ok(caller, &json!({ "tabId": tab_id }))
    }

    /// `browser_show`: brings the panel up on the caller session's tab. Changes no page.
    pub async fn show(&self, caller: &Caller, body: &Value) -> Answer {
        let request: BrowserShowRequest = parse(body)?;
        let tab_id = match request.tab_id {
            Some(tab_id) => tab_id,
            None => self.browser.active_tab_id(&caller.session)?.ok_or_else(|| refused(409, NO_ACTIVE_TAB))?,
        };
        self.fence(caller, &tab_id)?;
        self.browser.set_active_tab(&caller.session, &tab_id);
        if let (Actor::Agent, Some(agent_id)) = (caller.actor, &caller.agent_id) {
            if self.browser.present_allowed(&caller.session) {
                let get = BrowserGetRequest { tab_id: None, what: BrowserGetRequestWhat::Url, r#ref: None };
                let url = self.browser.get(&tab_id, &get).await.ok().map(|g| g.value).filter(|u| !u.is_empty());
                self.browser.publish_activity(BrowserActivity {
                    session_id: caller.session.clone(),
                    worker_id: agent_id.clone(),
                    kind: BrowserActivityKind::Present,
                    tab_id: tab_id.clone(),
                    url: url.clone(),
                });
                let mut payload = json!({ "tabId": tab_id, "verb": "show" });
                if let Some(url) = url {
                    payload["url"] = json!(url);
                }
                self.timeline(agent_id, payload).await;
            } else {
                tracing::info!(session = %caller.session, worker = %agent_id, tab = %tab_id, "browser present rate-limited");
            }
        }
        ok(caller, &json!({ "ok": true, "tabId": tab_id }))
    }

    pub async fn close_tab(&self, caller: &Caller, tab_id: &str) -> Answer {
        self.fence(caller, tab_id)?;
        self.browser.close_tab(tab_id).await?;
        ok(caller, &json!({ "ok": true }))
    }

    pub async fn navigate(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserNavigateRequest = parse(body)?;
        self.browser.navigate(tab_id, &request, caller.actor).await?;
        if request.action == BrowserNavigateRequestAction::Url {
            self.used(caller, tab_id, "navigate", request.url.as_deref()).await;
        }
        ok(caller, &json!({ "ok": true }))
    }

    pub async fn snapshot(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserSnapshotRequest = parse(body)?;
        ok(caller, &self.browser.snapshot(tab_id, &request).await?)
    }

    pub async fn find(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserFindRequest = parse(body)?;
        ok(caller, &self.browser.find(tab_id, &request.query).await?)
    }

    pub async fn wait(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserWaitRequest = parse(body)?;
        ok(caller, &self.browser.wait(tab_id, &request).await?)
    }

    /// Act, type, fill a form, press and scroll share one route: the body's shape says which.
    pub async fn act(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let has = |key: &str| body.get(key);
        let acted = if has("verb").is_some_and(Value::is_string) {
            self.browser.act(tab_id, &parse::<BrowserActRequest>(body)?).await?
        } else if has("fields").is_some_and(Value::is_array) {
            self.browser.fill_form(tab_id, &parse::<BrowserFillFormRequest>(body)?).await?
        } else if has("key").is_some_and(Value::is_string) {
            self.browser.press(tab_id, &parse::<BrowserPressRequest>(body)?).await?
        } else if has("direction").is_some_and(Value::is_string) {
            self.browser.scroll(tab_id, &parse::<BrowserScrollRequest>(body)?).await?
        } else if has("text").is_some_and(Value::is_string) && has("ref").is_some_and(Value::is_string) {
            self.browser.type_text(tab_id, &parse::<BrowserTypeRequest>(body)?).await?
        } else {
            return Err(refused(
                400,
                "unrecognized act body — expected one of: {ref,verb}, {ref,text}, {fields}, {key}, {direction}",
            ));
        };
        ok(caller, &acted)
    }

    pub async fn get(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserGetRequest = parse(body)?;
        ok(caller, &self.browser.get(tab_id, &request).await?)
    }

    /// A capture lands in a file the agent reads: `<temp>/eos-paste-<random>/browser-<tab>-<now>.jpeg`.
    pub async fn capture(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserScreenshotRequest = parse(body)?;
        let jpeg = self.browser.capture(tab_id, request.full_page).await?;
        let name = format!("browser-{tab_id}-{}.jpeg", self.clock.now_ms());
        let path = self.files.write_temp("eos-paste-", &name, &jpeg).await?;
        ok(caller, &json!({ "path": path.to_string_lossy() }))
    }

    pub async fn device(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserDeviceRequest = parse(body)?;
        ok(caller, &self.browser.set_device(tab_id, request.device).await?)
    }

    pub async fn elements(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserElementQuery = parse(body)?;
        ok(caller, &self.browser.element_at(tab_id, &request).await?)
    }

    pub async fn mute(&self, caller: &Caller, tab_id: &str, body: &Value) -> Answer {
        self.fence(caller, tab_id)?;
        let request: BrowserMuteRequest = parse(body)?;
        ok(caller, &self.browser.set_muted(tab_id, request.muted).await?)
    }
}

// ---- the agent tools ---------------------------------------------------------------------

fn body_of<T: Serialize>(request: &T) -> Result<Value, ApiError> {
    serde_json::to_value(request).map_err(|e| ApiError::Internal(e.to_string()))
}

impl Desk {
    async fn tool_call(&self, agent_id: &str, call: BrowserCall) -> Answer {
        let caller = self.caller(false, Some(agent_id), None).await?;
        let c = &caller;
        match call {
            BrowserCall::ActiveTab => self.active_tab(c).await,
            BrowserCall::Tabs => self.tabs(c).await,
            BrowserCall::NewTab(request) => self.new_tab(c, &body_of(&request)?).await,
            BrowserCall::CloseTab { tab_id } => self.close_tab(c, &tab_id).await,
            BrowserCall::Navigate { tab_id, request } => self.navigate(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Snapshot { tab_id, request } => self.snapshot(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Find { tab_id, request } => self.find(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Act { tab_id, request } => self.act(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Type { tab_id, request } => self.act(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::FillForm { tab_id, request } => self.act(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Press { tab_id, request } => self.act(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Scroll { tab_id, request } => self.act(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Get { tab_id, request } => self.get(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Wait { tab_id, request } => self.wait(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Screenshot { tab_id, request } => self.capture(c, &tab_id, &body_of(&request)?).await,
            BrowserCall::Show(request) => self.show(c, &body_of(&request)?).await,
            BrowserCall::Mute { tab_id, request } => self.mute(c, &tab_id, &body_of(&request)?).await,
        }
    }
}

impl BrowserTools for Desk {
    fn call<'a>(
        &'a self,
        agent_id: &'a str,
        call: BrowserCall,
    ) -> eos_core::BoxFuture<'a, Result<Value, BrowserError>> {
        Box::pin(async move {
            match self.tool_call(agent_id, call).await {
                Ok((_, value)) => Ok(value),
                Err(error) => Err(BrowserError { status: error.status(), message: error.to_string() }),
            }
        })
    }
}

// ---- the routes ----------------------------------------------------------------------------

/// The JSON body; an empty one reads as `{}`.
fn body(req: &Request) -> Result<Value, ApiError> {
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&req.body)
        .map_err(|_| ApiError::Validation("invalid request: body is not valid JSON".into()))
}

async fn caller_of(desk: &Desk, req: &Request) -> Result<Caller, ApiError> {
    let session = req.query().get("session");
    desk.caller(req.speaks_for_user(), req.headers.get("x-eos-agent-id"), session.as_deref()).await
}

fn answer(answer: Answer) -> Result<Response, ApiError> {
    answer.map(|(status, value)| Response::json(status, &value))
}

/// A route of the whole browser.
macro_rules! route {
    ($desk:expr, $method:ident, $path:literal, |$d:ident, $caller:ident, $req:ident| $call:expr) => {{
        let desk = $desk.clone();
        RouteDef::$method($path, move |$req: Request| {
            let $d = desk.clone();
            async move {
                let $caller = caller_of(&$d, &$req).await?;
                answer($call)
            }
        })
        .access(Access::open())
    }};
}

/// A route of one tab: `|desk, caller, tab id, body|`.
macro_rules! tab_route {
    ($desk:expr, $path:literal, $verb:ident) => {{
        let desk = $desk.clone();
        RouteDef::post($path, move |req: Request| {
            let desk = desk.clone();
            async move {
                let caller = caller_of(&desk, &req).await?;
                let tab_id = req.param("tabId").unwrap_or_default().to_owned();
                answer(desk.$verb(&caller, &tab_id, &body(&req)?).await)
            }
        })
        .access(Access::open())
    }};
}

pub(crate) fn all(desk: &Arc<Desk>) -> Vec<RouteDef> {
    vec![
        route!(desk, get, "/browser/status", |d, caller, _req| d.status(&caller).await),
        route!(desk, post, "/browser/launch", |d, caller, _req| d.launch(&caller).await),
        route!(desk, get, "/browser/tabs", |d, caller, _req| d.tabs(&caller).await),
        route!(desk, get, "/browser/active-tab", |d, caller, _req| d.active_tab(&caller).await),
        route!(desk, post, "/browser/tabs", |d, caller, req| d.new_tab(&caller, &body(&req)?).await),
        route!(desk, post, "/browser/show", |d, caller, req| d.show(&caller, &body(&req)?).await),
        route!(desk, delete, "/browser/tabs/{tabId}", |d, caller, req| {
            d.close_tab(&caller, req.param("tabId").unwrap_or_default()).await
        }),
        tab_route!(desk, "/browser/tabs/{tabId}/navigate", navigate),
        tab_route!(desk, "/browser/tabs/{tabId}/snapshot", snapshot),
        tab_route!(desk, "/browser/tabs/{tabId}/find", find),
        tab_route!(desk, "/browser/tabs/{tabId}/wait", wait),
        tab_route!(desk, "/browser/tabs/{tabId}/act", act),
        tab_route!(desk, "/browser/tabs/{tabId}/get", get),
        tab_route!(desk, "/browser/tabs/{tabId}/capture", capture),
        tab_route!(desk, "/browser/tabs/{tabId}/device", device),
        tab_route!(desk, "/browser/tabs/{tabId}/elements", elements),
        tab_route!(desk, "/browser/tabs/{tabId}/mute", mute),
    ]
}
