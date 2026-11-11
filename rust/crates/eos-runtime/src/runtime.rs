//! The pieces put together: what `eos-app` builds and drives.
//!
//! ```text
//! let kernel = Kernel::new(options);                  // lane, bus, stream, jobs
//! let modules = vec![PagesModule::new(&kernel, …), …]; // the app builds each feature from it
//! let runtime = Runtime::build(kernel, modules, plugins)?;
//! runtime.lifecycle.start().await?;                   // modules start
//! // … hand runtime.router to the bridge and the gateways …
//! runtime.lifecycle.ready().await?;                   // after_ready, then deferred work
//! runtime.shutdown(Duration::from_secs(5)).await;     // modules stop in reverse, streams end
//! ```

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::bus::{Bus, BusOptions, Subscription, TopicDecl};
use crate::error::Error;
use crate::idle::IdleHooks;
use crate::jobs::{JobOptions, JobRegistry};
use crate::lifecycle::{Lifecycle, ShutdownReport};
use crate::live_text::LiveText;
use crate::module::{Module, Modules, ProtectedSettings, SlashCommandDecl, SyncContribution, compose};
use crate::ordered::{DEFAULT_LANE_CAPACITY, Ordered};
use crate::router::{PluginSwitch, Router};
use crate::seams::{Clock, Ids, RandomIds, SystemClock, topics};
use crate::stream::{StreamHub, StreamOptions, routes as stream_routes};

#[derive(Clone)]
pub struct KernelOptions {
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub lane_capacity: usize,
    pub bus: BusOptions,
    pub stream: StreamOptions,
    pub jobs: JobOptions,
}

impl Default for KernelOptions {
    fn default() -> Self {
        Self {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds::default()),
            lane_capacity: DEFAULT_LANE_CAPACITY,
            bus: BusOptions::default(),
            stream: StreamOptions::default(),
            jobs: JobOptions::default(),
        }
    }
}

impl std::fmt::Debug for KernelOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelOptions")
            .field("lane_capacity", &self.lane_capacity)
            .field("bus", &self.bus)
            .field("stream", &self.stream)
            .finish_non_exhaustive()
    }
}

/// The services every feature is built from. Cheap to clone; a module keeps
/// the parts it uses.
#[derive(Debug, Clone)]
pub struct Kernel {
    /// The lane state transitions run on to be ordered with their events.
    pub ordered: Ordered,
    pub bus: Bus,
    pub stream: StreamHub,
    pub live_text: LiveText,
    pub jobs: JobRegistry,
    ids: Arc<IdsBox>,
    _wiring: Arc<Subscription>,
}

struct IdsBox(Arc<dyn Ids>);

impl std::fmt::Debug for IdsBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ids")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRemoved {
    worker_id: String,
}

impl Kernel {
    pub fn new(options: KernelOptions) -> Self {
        let ordered = Ordered::with_capacity(options.lane_capacity);
        let bus = Bus::new(ordered.clone(), options.clock, options.bus);
        let live_text = LiveText::new(&bus);
        let stream = StreamHub::new(&bus, options.ids.as_ref(), options.stream);
        let jobs = JobRegistry::new(bus.clone(), options.jobs);
        // A worker row is gone for good: its jobs have nothing left to link to.
        let registry = jobs.clone();
        let wiring = bus.on(topics::WORKER_REMOVED, move |ev| {
            if let Ok(removed) = ev.payload_as::<WorkerRemoved>() {
                registry.forget_worker(&removed.worker_id);
            }
        });
        Self { ordered, bus, stream, live_text, jobs, ids: Arc::new(IdsBox(options.ids)), _wiring: Arc::new(wiring) }
    }
}

/// The running app as the host sees it.
pub struct Runtime {
    pub kernel: Kernel,
    /// What the bridge and the phone and peer gateways call.
    pub router: Arc<Router>,
    pub modules: Modules,
    /// Run for a worker that settles at IDLE with an empty queue.
    pub idle: IdleHooks,
    pub lifecycle: Lifecycle,
    /// Declared by the modules, for the services that consume them.
    pub topics: Vec<TopicDecl>,
    pub job_kinds: Vec<&'static str>,
    pub slash_commands: Vec<SlashCommandDecl>,
    pub protected_settings: Vec<ProtectedSettings>,
    pub sync: Vec<SyncContribution>,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime").field("modules", &self.modules).field("router", &self.router).finish_non_exhaustive()
    }
}

impl Runtime {
    /// Composes the modules (failing on any clash between them), builds the
    /// router from their routes plus the stream's (failing on a route without
    /// an access rule), and collects their idle hooks. Nothing runs yet.
    pub fn build(kernel: Kernel, modules: Vec<Arc<dyn Module>>, plugins: Arc<dyn PluginSwitch>) -> Result<Self, Error> {
        let composed = compose(modules, plugins.clone())?;
        let router = Router::builder()
            .plugins(plugins)
            .ids(kernel.ids.0.clone())
            .routes(stream_routes::routes(kernel.stream.clone(), kernel.live_text.clone()))
            .routes(composed.routes)
            .build()?;
        Ok(Self {
            router: Arc::new(router),
            idle: IdleHooks::new(composed.idle_hooks),
            lifecycle: Lifecycle::new(composed.modules.clone()),
            modules: composed.modules,
            topics: composed.topics,
            job_kinds: composed.job_kinds,
            slash_commands: composed.slash_commands,
            protected_settings: composed.protected_settings,
            sync: composed.sync,
            kernel,
        })
    }

    /// Stops everything inside `deadline`: the modules (last first), then the
    /// streams (each ends after what it has queued), the job list and the
    /// ordered lane (after the jobs already queued on it).
    pub async fn shutdown(&self, deadline: Duration) -> ShutdownReport {
        let began = tokio::time::Instant::now();
        let report = self.lifecycle.shutdown(deadline).await;
        self.kernel.stream.close();
        self.kernel.jobs.dispose();
        let left = deadline.saturating_sub(began.elapsed()).max(Duration::from_millis(50));
        if tokio::time::timeout(left, self.kernel.ordered.stop()).await.is_err() {
            tracing::error!("the ordered lane did not drain before the shutdown deadline");
        }
        ShutdownReport { took: began.elapsed(), ..report }
    }
}
