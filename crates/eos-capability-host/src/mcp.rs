//! The `mcp` form: one confined MCP server per capability, started at its
//! first call and spoken to over its stdin and stdout.
//!
//! Its tools are the ones its manifest froze at review: a server that lists
//! another tool, or a description other than its action's summary, is not
//! believed (`tools_changed`). A server idle for ten minutes is stopped; at
//! most eight run at once. One that ends on its own three times in ten
//! minutes is not started again until that window has passed
//! (`server_crashed`), so the capability reads as broken.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use eos_core::capability::{ActionError, ConfineGuard, FailureKind, Package};
use eos_core::{Clock, Ids, Sleeper};
use eos_domain::capability::manifest::{Action, McpServer};
use eos_kit_proc::{Child, Command, Env, Event, Runner};
use rmcp::model::{CallToolRequestParams, ContentBlock};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OnceCell, oneshot};
use zeroize::Zeroizing;

use crate::confined::{Layout, code_failed, remove_temp, report};
use crate::script::OUTPUT_MAX_BYTES;

/// At most this many servers run at once.
pub const SERVERS_ALIVE_MAX: usize = 8;
/// A server no call used for this long is stopped.
pub const IDLE_STOP_MS: i64 = 10 * 60_000;
/// Ends of its own within [`CRASH_WINDOW_MS`] that break a capability.
pub const CRASHES_TO_BREAK: usize = 3;
pub const CRASH_WINDOW_MS: i64 = 10 * 60_000;
/// The state code a server that crashed too often is refused with.
pub const SERVER_CRASHED: &str = "server_crashed";
/// The state code a server whose tools are not the reviewed ones is refused with.
pub const TOOLS_CHANGED: &str = "tools_changed";

/// How long a server may take to greet Eos and list its tools.
const START_TIMEOUT: Duration = Duration::from_secs(30);
const PIPE_BYTES: usize = 64 * 1024;

/// Runs `mcp` packages from `<root>/<id>/<version>/`, one server each.
#[derive(Clone)]
pub(crate) struct McpHost {
    inner: Arc<Inner>,
}

struct Inner {
    layout: Layout,
    runner: Runner,
    ids: Arc<dyn Ids>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    /// When each capability's server last ended on its own.
    crashes: Mutex<HashMap<String, Vec<i64>>>,
}

/// One capability's server, started by the first call that needs it.
struct Slot {
    version: String,
    server: OnceCell<Server>,
    last_used: AtomicI64,
    calls: AtomicUsize,
    /// Set once Eos ends it, so its exit is no crash.
    stopping: AtomicBool,
}

struct Server {
    client: RunningService<RoleClient, ()>,
    /// Dropped (with the slot) or fired, it ends the server's process tree.
    _stop: oneshot::Sender<()>,
}

impl std::fmt::Debug for McpHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpHost").field("root", &self.inner.layout.root).finish_non_exhaustive()
    }
}

impl McpHost {
    pub(crate) fn new(
        layout: Layout,
        runner: Runner,
        ids: Arc<dyn Ids>,
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
    ) -> Self {
        let inner = Inner {
            layout,
            runner,
            ids,
            clock,
            sleeper,
            slots: Mutex::new(HashMap::new()),
            crashes: Mutex::new(HashMap::new()),
        };
        Self { inner: Arc::new(inner) }
    }

    pub(crate) async fn run(
        &self,
        package: &Package,
        action: &Action,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
    ) -> Result<Value, ActionError> {
        let (id, name) = (package.id.as_str(), action.name.as_str());
        let Some(tool) = action.tool.clone() else {
            return Err(code_failed(id, name, "it names no tool"));
        };
        let Some(McpServer::Local(server)) = &package.manifest.server else {
            return Err(code_failed(id, name, "a remote server is not run here"));
        };
        let Value::Object(arguments) = input else {
            return Err(ActionError::Invalid("Input validation error: the input is no object".into()));
        };
        let slot = self.inner.slot(package)?;
        slot.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.call(&slot, package, &server.run, env, tool, arguments, timeout).await;
        slot.last_used.store(self.inner.clock.now_ms(), Ordering::SeqCst);
        slot.calls.fetch_sub(1, Ordering::SeqCst);
        answer
    }

    #[allow(clippy::too_many_arguments)]
    async fn call(
        &self,
        slot: &Arc<Slot>,
        package: &Package,
        line: &[String],
        env: Vec<(String, Zeroizing<String>)>,
        tool: String,
        arguments: serde_json::Map<String, Value>,
        timeout: Duration,
    ) -> Result<Value, ActionError> {
        let id = package.id.as_str();
        let server = slot.server.get_or_try_init(|| self.inner.clone().start(slot.clone(), package, line, env)).await?;
        let called = tokio::time::timeout(
            timeout,
            server.client.call_tool(CallToolRequestParams::new(tool).with_arguments(arguments)),
        )
        .await;
        let result = match called {
            Err(_) => {
                // A server that missed a deadline may be stuck on it: the next call gets a fresh one.
                slot.stopping.store(true, Ordering::SeqCst);
                self.inner.forget(id, slot);
                tracing::info!(capability = id, "an mcp action ran past its deadline");
                return Err(ActionError::Timeout);
            }
            Ok(Err(rmcp::ServiceError::McpError(_))) => {
                tracing::info!(capability = id, "an mcp server refused a call");
                return Err(ActionError::Failed { kind: FailureKind::Code });
            }
            Ok(Err(_)) => {
                // The server is gone: the next call starts another, unless it
                // ended once too often.
                self.inner.forget(id, slot);
                if self.inner.crashed_out(id) {
                    return Err(ActionError::NotReady(SERVER_CRASHED.into()));
                }
                return Err(code_failed(id, "call", "its server did not answer"));
            }
            Ok(Ok(result)) => result,
        };
        if result.is_error == Some(true) {
            tracing::info!(capability = id, "an mcp action failed");
            return Err(ActionError::Failed { kind: FailureKind::Code });
        }
        let answer = match result.structured_content {
            Some(value) => value,
            None => json!({ "text": text_of(&result.content) }),
        };
        if serde_json::to_vec(&answer).map_or(true, |bytes| bytes.len() > OUTPUT_MAX_BYTES) {
            return Err(code_failed(id, "call", "it said too much"));
        }
        Ok(answer)
    }

    /// Ends capability `id`'s server; its calls in flight fail.
    pub(crate) fn stop(&self, id: &str) {
        let slot = self.inner.locked_slots().remove(id);
        if let Some(slot) = slot {
            slot.stopping.store(true, Ordering::SeqCst);
        }
    }
}

impl Inner {
    fn locked_slots(&self) -> MutexGuard<'_, HashMap<String, Arc<Slot>>> {
        self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Drops `slot` from the map unless another took its place.
    fn forget(&self, id: &str, slot: &Arc<Slot>) {
        let mut slots = self.locked_slots();
        if slots.get(id).is_some_and(|kept| Arc::ptr_eq(kept, slot)) {
            slots.remove(id);
        }
    }

    fn crashed(&self, id: &str) {
        let now = self.clock.now_ms();
        self.locked_crashes().entry(id.to_owned()).or_default().push(now);
        tracing::warn!(capability = %id, "an mcp server ended on its own");
    }

    fn locked_crashes(&self) -> MutexGuard<'_, HashMap<String, Vec<i64>>> {
        self.crashes.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The slot of the package's version; a slot of another version is
    /// stopped, and the least used idle one makes room past the limit.
    fn slot(&self, package: &Package) -> Result<Arc<Slot>, ActionError> {
        if self.crashed_out(&package.id) {
            return Err(ActionError::NotReady(SERVER_CRASHED.into()));
        }
        let mut slots = self.locked_slots();
        if let Some(slot) = slots.get(&package.id) {
            if slot.version == package.version {
                return Ok(slot.clone());
            }
            if let Some(old) = slots.remove(&package.id) {
                old.stopping.store(true, Ordering::SeqCst);
            }
        }
        if slots.len() >= SERVERS_ALIVE_MAX {
            let idle = slots
                .iter()
                .filter(|(_, slot)| slot.calls.load(Ordering::SeqCst) == 0)
                .min_by_key(|(_, slot)| slot.last_used.load(Ordering::SeqCst))
                .map(|(id, _)| id.clone());
            let Some(idle) = idle else {
                return Err(ActionError::Busy);
            };
            if let Some(old) = slots.remove(&idle) {
                old.stopping.store(true, Ordering::SeqCst);
                tracing::info!(capability = %idle, "an mcp server stopped to make room");
            }
        }
        let slot = Arc::new(Slot {
            version: package.version.clone(),
            server: OnceCell::new(),
            last_used: AtomicI64::new(self.clock.now_ms()),
            calls: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
        });
        slots.insert(package.id.clone(), slot.clone());
        Ok(slot)
    }

    /// Whether the server ended on its own too often of late.
    fn crashed_out(&self, id: &str) -> bool {
        let since = self.clock.now_ms() - CRASH_WINDOW_MS;
        let mut crashes = self.locked_crashes();
        let Some(times) = crashes.get_mut(id) else { return false };
        times.retain(|at| *at > since);
        times.len() >= CRASHES_TO_BREAK
    }

    /// Starts the server under the sandbox, greets it and checks its tools
    /// against the frozen ones.
    async fn start(
        self: Arc<Self>,
        slot: Arc<Slot>,
        package: &Package,
        line: &[String],
        env: Vec<(String, Zeroizing<String>)>,
    ) -> Result<Server, ActionError> {
        let id = package.id.clone();
        let tmpdir = self.layout.temp.join(format!("mcp-{}", self.ids.uuid()));
        let confined = match self.layout.confine(package, "server", line, &env, &tmpdir).await {
            Ok(confined) => confined,
            Err(error) => {
                remove_temp(&id, &tmpdir).await;
                return Err(error);
            }
        };
        let mut environment = Env::empty();
        for (variable, value) in &confined.env {
            environment = environment.set(variable, value);
        }
        let command = Command::new(&confined.program)
            .args(&confined.args)
            .cwd(self.layout.package_dir(package))
            .env(environment)
            .stdin_open()
            .no_timeout();
        let mut child = match self.runner.spawn(command).await {
            Ok(child) => child,
            Err(_) => {
                report(&id, "server", confined.guard.finish().await);
                remove_temp(&id, &tmpdir).await;
                return Err(code_failed(&id, "server", "it could not start"));
            }
        };
        let stdin = child.stdin();
        let (ours, theirs) = tokio::io::duplex(PIPE_BYTES);
        let (stop, stopped) = oneshot::channel();
        let ended = Ended { host: Arc::downgrade(&self), slot: Arc::downgrade(&slot), id: id.clone(), tmpdir };
        tokio::spawn(pump(child, stdin, theirs, stopped, confined.guard, ended));
        let greeted = tokio::time::timeout(START_TIMEOUT, async {
            let client = ().serve(ours).await.ok()?;
            let tools = client.list_all_tools().await.ok()?;
            Some((client, tools))
        })
        .await;
        let Ok(Some((client, tools))) = greeted else {
            // Counted here, once: dropping `stop` ends what is left of it.
            slot.stopping.store(true, Ordering::SeqCst);
            self.forget(&id, &slot);
            self.crashed(&id);
            return Err(code_failed(&id, "server", "it did not greet Eos"));
        };
        let listed: Vec<(String, String)> = tools
            .iter()
            .map(|tool| (tool.name.to_string(), tool.description.as_deref().unwrap_or_default().trim().to_owned()))
            .collect();
        if !frozen(&package.manifest.actions, &listed) {
            slot.stopping.store(true, Ordering::SeqCst);
            self.forget(&id, &slot);
            tracing::warn!(capability = %id, tools = listed.len(), "an mcp server's tools are not the reviewed ones");
            return Err(ActionError::NotReady(TOOLS_CHANGED.into()));
        }
        tracing::info!(capability = %id, tools = listed.len(), "an mcp server started");
        tokio::spawn(idle_watch(Arc::downgrade(&self), Arc::downgrade(&slot), id));
        Ok(Server { client, _stop: stop })
    }
}

/// Whether the server lists exactly the reviewed tools, each with the
/// description its action's summary froze.
fn frozen(actions: &[Action], listed: &[(String, String)]) -> bool {
    let reviewed: HashMap<&str, &str> =
        actions.iter().filter_map(|action| Some((action.tool.as_deref()?, action.summary.trim()))).collect();
    listed.len() == reviewed.len()
        && listed.iter().all(|(name, description)| reviewed.get(name.as_str()) == Some(&description.as_str()))
}

fn text_of(content: &[ContentBlock]) -> String {
    content.iter().filter_map(|block| block.as_text().map(|text| text.text.as_str())).collect::<Vec<_>>().join("\n")
}

/// What to settle once a server's process has ended.
struct Ended {
    host: Weak<Inner>,
    slot: Weak<Slot>,
    id: String,
    tmpdir: PathBuf,
}

/// Carries bytes between the server's pipes and the client, and ends the
/// process tree when told to or when the server is dropped.
async fn pump(
    mut child: Child,
    stdin: Option<eos_kit_proc::Stdin>,
    theirs: tokio::io::DuplexStream,
    mut stop: oneshot::Receiver<()>,
    guard: Box<dyn ConfineGuard>,
    ended: Ended,
) {
    let (mut from_client, mut to_client) = tokio::io::split(theirs);
    if let Some(mut stdin) = stdin {
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 8192];
            while let Ok(read) = from_client.read(&mut buffer).await {
                if read == 0 || stdin.write(&buffer[..read]).await.is_err() {
                    break;
                }
            }
        });
    }
    let mut killed = false;
    loop {
        tokio::select! {
            _ = &mut stop, if !killed => {
                killed = true;
                child.kill();
            }
            event = child.next() => match event {
                Some(Event::Stdout(bytes)) => {
                    if to_client.write_all(&bytes).await.is_err() && !killed {
                        killed = true;
                        child.kill();
                    }
                }
                Some(Event::Stderr(_)) => {}
                Some(Event::Exit(_)) | None => break,
            },
        }
    }
    drop(to_client);
    report(&ended.id, "server", guard.finish().await);
    remove_temp(&ended.id, &ended.tmpdir).await;
    let on_purpose = killed || ended.slot.upgrade().is_none_or(|slot| slot.stopping.load(Ordering::SeqCst));
    let Some(host) = ended.host.upgrade() else { return };
    if let Some(slot) = ended.slot.upgrade() {
        host.forget(&ended.id, &slot);
    }
    if on_purpose {
        tracing::info!(capability = %ended.id, "an mcp server stopped");
    } else {
        host.crashed(&ended.id);
    }
}

/// Stops the server once no call used it for [`IDLE_STOP_MS`].
async fn idle_watch(host: Weak<Inner>, slot: Weak<Slot>, id: String) {
    let Some(sleeper) = host.upgrade().map(|host| host.sleeper.clone()) else { return };
    loop {
        sleeper.sleep(IDLE_STOP_MS).await;
        let (Some(host), Some(watched)) = (host.upgrade(), slot.upgrade()) else { return };
        if watched.stopping.load(Ordering::SeqCst) {
            return;
        }
        let idle = host.clock.now_ms() - watched.last_used.load(Ordering::SeqCst);
        if watched.calls.load(Ordering::SeqCst) == 0 && idle >= IDLE_STOP_MS {
            host.forget(&id, &watched);
            watched.stopping.store(true, Ordering::SeqCst);
            tracing::info!(capability = %id, "an idle mcp server stopped");
            return;
        }
    }
}
