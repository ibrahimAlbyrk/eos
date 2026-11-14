//! The ports the agent tools call, scripted: each call takes the next
//! scripted answer — a status and a JSON body, as the route behind the tool
//! answered it — and hands it back in the port's own types.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eos_contracts::{
    IntegrateWorkersResponse, LocationResponse, Page, PageEditRequest, PageSummary, PeerListItem, PeerRef,
    PlacesRequest, PluginInfo, PluginPreviewRequest, SpawnWorkerRequest, TransferRecord, UnknownRecord, UserMemory,
    UserMemorySuggestRequest, UserMemorySuggestResponse,
};
use eos_core::agent::{
    DirectiveSent, KilledWorker, PeerAnswered, PeerConsult, Peers, Refused, SessionFolder, SpawnedWorker, UserNotifier,
    UserQuestions, WorkerControl,
};
use eos_core::browser::{BrowserCall, BrowserError, BrowserTools};
use eos_core::genui::{
    LocationRefusal, PlaceCenter, Places, PlacesError, PlacesFound, PresentRefusal, PresentedApp, PresentedView,
    UserLocation, VisualAnswers,
};
use eos_core::os::TimeZone;
use eos_core::pages::PageEditor;
use eos_core::plugin::{PluginPreviewed, PluginStatus, Plugins};
use eos_core::profile::{MemorySearch, MemorySuggestions, UserMemorySuggestResult};
use eos_core::transfer::AgentTransfers;
use eos_core::{BoxFuture, Error};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

fn typed<T: DeserializeOwned>(what: &str, body: Value) -> T {
    serde_json::from_value(body).unwrap_or_else(|e| panic!("the scripted answer for {what} has another shape: {e}"))
}

/// A refusal's status as the error a port fails with.
fn core_error(refused: Refused) -> Error {
    let message = refused.message;
    match refused.status {
        404 => match message.split_once(" not found: ") {
            Some(("page", id)) => Error::not_found("page", id),
            Some(("plugin", id)) => Error::not_found("plugin", id),
            Some(("worker", id)) => Error::not_found("worker", id),
            _ => Error::not_found("thing", message),
        },
        409 => Error::Conflict(message),
        403 => Error::PermissionDenied(message),
        429 => Error::LimitExceeded(message),
        502 => Error::Unreachable(message),
        400 => Error::Validation(message),
        _ => Error::Storage(message),
    }
}

/// Every feature the agent tools reach, answering from one script in the
/// order the answers were given. A call nobody scripted fails the test.
#[derive(Debug, Default)]
pub struct FakeFeatures {
    answers: Mutex<VecDeque<(u16, Value)>>,
    calls: Mutex<Vec<(String, Value)>>,
    /// Where the calling session works ([`WorkerControl::folder`]).
    pub folder: SessionFolder,
    /// The built-in plugins that are switched off.
    pub plugins_off: Mutex<Vec<String>>,
    plugins_dir: Mutex<String>,
}

impl FakeFeatures {
    pub fn new(answers: impl IntoIterator<Item = (u16, Value)>) -> Arc<Self> {
        Arc::new(Self { answers: Mutex::new(answers.into_iter().collect()), ..Self::default() })
    }

    pub fn in_folder(cwd: &str, git_repo: bool, answers: impl IntoIterator<Item = (u16, Value)>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into_iter().collect()),
            folder: SessionFolder { cwd: cwd.to_owned(), git_repo },
            ..Self::default()
        })
    }

    /// Each call so far: the operation and what it was asked with.
    pub fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().expect("calls").clone()
    }

    /// Scripted answers nobody asked for.
    pub fn unasked(&self) -> usize {
        self.answers.lock().expect("answers").len()
    }

    fn next(&self, op: &str, asked: Value) -> Result<Value, Refused> {
        self.calls.lock().expect("calls").push((op.to_owned(), asked));
        let (status, body) =
            self.answers.lock().expect("answers").pop_front().unwrap_or_else(|| panic!("no scripted answer for {op}"));
        if (200..300).contains(&status) {
            return Ok(body);
        }
        let message = body.get("error").and_then(Value::as_str).map_or_else(|| body.to_string(), str::to_owned);
        Err(Refused::new(status, message))
    }

    fn core(&self, op: &str, asked: Value) -> Result<Value, Error> {
        self.next(op, asked).map_err(core_error)
    }
}

impl WorkerControl for FakeFeatures {
    fn folder<'a>(&'a self, _worker_id: &'a str) -> BoxFuture<'a, SessionFolder> {
        ready(self.folder.clone())
    }

    fn spawn(&self, request: SpawnWorkerRequest) -> BoxFuture<'_, Result<SpawnedWorker, Refused>> {
        ready(self.next("spawn", json!(request)).map(|body| SpawnedWorker {
            id: typed("spawn", body["id"].clone()),
            isolation: typed("spawn", body["isolation"].clone()),
        }))
    }

    fn message<'a>(
        &'a self,
        parent_id: &'a str,
        worker_id: &'a str,
        text: String,
    ) -> BoxFuture<'a, Result<DirectiveSent, Refused>> {
        let asked = json!({"parentId": parent_id, "workerId": worker_id, "text": text});
        ready(self.next("message", asked).map(|body| DirectiveSent {
            id: typed("message", body["id"].clone()),
            name: typed("message", body["name"].clone()),
        }))
    }

    fn kill<'a>(&'a self, actor_id: &'a str, worker_id: &'a str) -> BoxFuture<'a, Result<KilledWorker, Refused>> {
        let asked = json!({"actorId": actor_id, "workerId": worker_id});
        ready(self.next("kill", asked).map(|body| KilledWorker {
            id: typed("kill", body["id"].clone()),
            name: typed("kill", body["name"].clone()),
            removed: typed("kill", body["removed"].clone()),
            was_state: typed("kill", body["was_state"].clone()),
        }))
    }

    fn report<'a>(&'a self, worker_id: &'a str, text: String) -> BoxFuture<'a, Result<(), Refused>> {
        ready(self.next("report", json!({"workerId": worker_id, "text": text})).map(|_| ()))
    }

    fn integrate<'a>(
        &'a self,
        orchestrator_id: &'a str,
        ids: Option<Vec<String>>,
    ) -> BoxFuture<'a, Result<IntegrateWorkersResponse, Refused>> {
        let asked = json!({"orchestratorId": orchestrator_id, "ids": ids});
        ready(self.next("integrate", asked).map(|body| typed("integrate", body)))
    }
}

impl UserNotifier for FakeFeatures {
    fn notify(&self, worker_id: &str, title: &str, body: &str) {
        let _ = self.next("notify", json!({"workerId": worker_id, "title": title, "body": body}));
    }
}

impl UserQuestions for FakeFeatures {
    /// Scripted as the register-then-poll exchange it used to be: the
    /// registration, then states until one is not `pending`.
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        _call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        let _ = self.next("ask", json!({"workerId": worker_id, "questions": questions}));
        loop {
            let Ok(state) = self.next("ask:poll", Value::Null) else { continue };
            match state["status"].as_str() {
                Some("pending") => {}
                Some("answered") => return ready(Some(typed("ask", state["answers"].clone()))),
                _ => return ready(None),
            }
        }
    }
}

impl PageEditor for FakeFeatures {
    fn list<'a>(
        &'a self,
        agent_id: &'a str,
        query: Option<&'a str>,
        all: bool,
    ) -> BoxFuture<'a, Result<Vec<PageSummary>, Error>> {
        let asked = json!({"agentId": agent_id, "query": query, "all": all});
        ready(self.core("pages.list", asked).map(|body| typed("pages.list", body["pages"].clone())))
    }

    fn read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Arc<Page>, Error>> {
        ready(
            self.core("pages.read", json!({"id": id})).map(|body| Arc::new(typed("pages.read", body["page"].clone()))),
        )
    }

    fn create<'a>(
        &'a self,
        agent_id: &'a str,
        title: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, Result<Arc<Page>, Error>> {
        let asked = json!({"agentId": agent_id, "title": title, "body": body});
        ready(self.core("pages.create", asked).map(|body| Arc::new(typed("pages.create", body["page"].clone()))))
    }

    fn edit<'a>(
        &'a self,
        agent_id: &'a str,
        id: &'a str,
        edit: &'a PageEditRequest,
    ) -> BoxFuture<'a, Result<Arc<Page>, Error>> {
        let asked = json!({"agentId": agent_id, "id": id, "edit": edit});
        ready(self.core("pages.edit", asked).map(|body| Arc::new(typed("pages.edit", body["page"].clone()))))
    }
}

impl MemorySearch for FakeFeatures {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Arc<UserMemory>>, Error>> {
        let asked = json!({"agentId": agent_id, "query": query, "limit": limit});
        ready(self.core("memory.search", asked).map(|body| {
            let memories: Vec<UserMemory> = typed("memory.search", body["memories"].clone());
            memories.into_iter().map(Arc::new).collect()
        }))
    }
}

impl MemorySuggestions for FakeFeatures {
    fn suggest<'a>(
        &'a self,
        agent_id: &'a str,
        request: UserMemorySuggestRequest,
    ) -> BoxFuture<'a, Result<UserMemorySuggestResult, Error>> {
        let asked = json!({"agentId": agent_id, "request": request});
        ready(self.core("memory.suggest", asked).map(|body| {
            let answer: UserMemorySuggestResponse = typed("memory.suggest", body);
            UserMemorySuggestResult {
                memory: Arc::new(answer.memory),
                duplicate: answer.duplicate,
                declined: answer.declined,
            }
        }))
    }
}

impl Plugins for FakeFeatures {
    fn dir(&self) -> String {
        self.plugins_dir.lock().expect("dir").clone()
    }

    /// Scripted as the plugin list's answer: `{ plugins, dir }`.
    fn list(&self) -> Vec<PluginInfo> {
        let Ok(body) = self.next("plugins.list", Value::Null) else { return Vec::new() };
        *self.plugins_dir.lock().expect("dir") = typed("plugins.list", body["dir"].clone());
        typed("plugins.list", body["plugins"].clone())
    }

    fn status<'a>(&'a self, id: &'a str, wait: bool) -> BoxFuture<'a, Result<PluginStatus, Error>> {
        ready(self.core("plugins.status", json!({"id": id, "wait": wait})).map(|body| PluginStatus {
            plugin: typed("plugins.status", body["plugin"].clone()),
            report: typed("plugins.status", body["report"].clone()),
            busy: false,
        }))
    }

    fn preview<'a>(
        &'a self,
        id: &'a str,
        request: PluginPreviewRequest,
    ) -> BoxFuture<'a, Result<PluginPreviewed, Error>> {
        ready(self.core("plugins.preview", json!({"id": id, "request": request})).map(|body| PluginPreviewed {
            path: typed("plugins.preview", body["path"].clone()),
            build: typed("plugins.preview", body["build"].clone()),
            surface: typed("plugins.preview", body["surface"].clone()),
            view: typed("plugins.preview", body["view"].clone()),
            width: typed("plugins.preview", body["width"].clone()),
            height: typed("plugins.preview", body["height"].clone()),
            errors: typed("plugins.preview", body["errors"].clone()),
            available: typed("plugins.preview", body["available"].clone()),
        }))
    }

    fn is_enabled(&self, id: &str) -> bool {
        !self.disabled_builtins().iter().any(|off| off == id)
    }

    fn disabled_builtins(&self) -> Vec<String> {
        self.plugins_off.lock().expect("plugins off").clone()
    }

    fn authoring_plugin(&self) -> Option<PathBuf> {
        None
    }
}

impl BrowserTools for FakeFeatures {
    fn call<'a>(&'a self, agent_id: &'a str, call: BrowserCall) -> BoxFuture<'a, Result<Value, BrowserError>> {
        let asked = json!({"agentId": agent_id, "call": format!("{call:?}")});
        ready(self.next("browser", asked).map_err(|e| BrowserError { status: e.status, message: e.message }))
    }
}

impl FakeFeatures {
    fn present(&self, op: &str, worker_id: &str, input: Value) -> Result<Value, PresentRefusal> {
        let asked = json!({"workerId": worker_id, "input": input});
        let mut answers = self.answers.lock().expect("answers");
        self.calls.lock().expect("calls").push((op.to_owned(), asked));
        let (status, body) = answers.pop_front().unwrap_or_else(|| panic!("no scripted answer for {op}"));
        if (200..300).contains(&status) {
            return Ok(body);
        }
        if let Some(problems) = body.get("problems").filter(|p| p.as_array().is_some_and(|list| !list.is_empty())) {
            return Err(PresentRefusal::Rejected(typed(op, problems.clone())));
        }
        let message = body["error"].as_str().unwrap_or_default().to_owned();
        Err(match status {
            403 if message == eos_genui::spec::GENUI_OFF_TEXT => {
                PresentRefusal::SwitchedOff(eos_genui::spec::GENUI_OFF_TEXT)
            }
            _ => PresentRefusal::Failed(core_error(Refused::new(status, message))),
        })
    }
}

impl VisualAnswers for FakeFeatures {
    fn present_view<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedView, PresentRefusal>> {
        ready(self.present("present", worker_id, input).map(|body| PresentedView {
            view_id: typed("present", body["viewId"].clone()),
            warnings: body.get("warnings").map(|w| typed("present", w.clone())).unwrap_or_default(),
            stats: typed("present", body["stats"].clone()),
        }))
    }

    fn present_app<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedApp, PresentRefusal>> {
        ready(self.present("present_app", worker_id, input).map(|body| PresentedApp {
            view_id: typed("present_app", body["viewId"].clone()),
            warnings: body.get("warnings").map(|w| typed("present_app", w.clone())).unwrap_or_default(),
        }))
    }
}

impl Places for FakeFeatures {
    fn find(&self, request: PlacesRequest) -> BoxFuture<'_, Result<PlacesFound, PlacesError>> {
        ready(match self.next("places", json!(request)) {
            Ok(body) => Ok(PlacesFound {
                places: typed("places", body["places"].clone()),
                // The one credit line the map data asks for.
                attribution: "© OpenStreetMap contributors",
                center: PlaceCenter {
                    lat: typed("places", body["center"]["lat"].clone()),
                    lon: typed("places", body["center"]["lon"].clone()),
                    label: body["center"].get("label").map(|l| typed("places", l.clone())),
                },
                radius_m: typed("places", body["radiusM"].clone()),
            }),
            Err(e) if e.status == 404 => Err(PlacesError::UnknownPlace(e.message)),
            Err(e) => Err(PlacesError::Service(e.message)),
        })
    }
}

impl UserLocation for FakeFeatures {
    fn current_for<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<LocationResponse, LocationRefusal>> {
        ready(match self.next("location", json!({"workerId": worker_id})) {
            Ok(body) => Ok(typed("location", body)),
            Err(e) => Err(LocationRefusal { status: e.status, code: "refused", message: e.message }),
        })
    }
}

impl Peers for FakeFeatures {
    fn list<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<PeerListItem>, Refused>> {
        ready(self.next("peers.list", json!({"workerId": worker_id})).map(|body| typed("peers.list", body)))
    }

    /// Scripted as the register-then-poll exchange it used to be.
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        target: PeerRef,
        question: String,
    ) -> BoxFuture<'a, Result<PeerConsult, Refused>> {
        let asked = json!({"workerId": worker_id, "target": target, "question": question});
        let registered = match self.next("peers.ask", asked) {
            Ok(body) => body,
            Err(e) => return ready(Err(e)),
        };
        if registered.get("requestId").and_then(Value::as_str).is_none() {
            return ready(Ok(PeerConsult::NotSent { reason: typed("peers.ask", registered["reason"].clone()) }));
        }
        loop {
            let Ok(state) = self.next("peers.ask:poll", Value::Null) else { continue };
            let reason = || typed("peers.ask", state["reason"].clone());
            match state["status"].as_str() {
                Some("pending") => {}
                Some("answered") => {
                    return ready(Ok(PeerConsult::Answered(state["answer"].as_str().unwrap_or_default().to_owned())));
                }
                Some("declined") => return ready(Ok(PeerConsult::Declined { reason: reason() })),
                _ => return ready(Ok(PeerConsult::Gone)),
            }
        }
    }

    fn respond<'a>(
        &'a self,
        worker_id: &'a str,
        answer: String,
    ) -> BoxFuture<'a, Result<Option<PeerAnswered>, Refused>> {
        ready(self.next("peers.respond", json!({"workerId": worker_id, "answer": answer})).map(|body| {
            (body["outcome"] == "answered").then(|| PeerAnswered {
                to_worker: typed("peers.respond", body["toWorker"].clone()),
                to_name: typed("peers.respond", body["toName"].clone()),
            })
        }))
    }
}

impl AgentTransfers for FakeFeatures {
    fn start<'a>(
        &'a self,
        worker_id: &'a str,
        machine: &'a str,
        paths: Vec<String>,
    ) -> BoxFuture<'a, Result<TransferRecord, Refused>> {
        let asked = json!({"workerId": worker_id, "machine": machine, "paths": paths});
        ready(self.next("transfers.start", asked).map(|body| typed("transfers.start", body)))
    }

    fn get<'a>(&'a self, worker_id: &'a str, transfer_id: &'a str) -> BoxFuture<'a, Result<TransferRecord, Refused>> {
        let asked = json!({"workerId": worker_id, "transferId": transfer_id});
        ready(self.next("transfers.get", asked).map(|body| typed("transfers.get", body)))
    }
}

/// A time zone with one fixed offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeTimeZone {
    pub name: String,
    pub offset_minutes: i32,
}

impl FakeTimeZone {
    pub fn new(name: &str, offset_minutes: i32) -> Self {
        Self { name: name.to_owned(), offset_minutes }
    }
}

impl TimeZone for FakeTimeZone {
    fn name(&self) -> String {
        self.name.clone()
    }

    fn offset_minutes_at(&self, _epoch_ms: i64) -> i32 {
        self.offset_minutes
    }
}
