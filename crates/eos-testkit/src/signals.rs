//! Signal sources and the runner, answered from what the test scripts.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::BoxFuture;
use eos_core::signals::{
    DeviceReport, DeviceSeen, FactDecl, Handoff, Holder, PollPage, PollRequest, PushEvent, PushOutcome, RunnerError,
    Scope, SignalSource, SignalSources, SourceError,
};
use serde_json::Value;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A source that answers each poll with the next scripted page or error;
/// once the script runs out, an empty page that keeps the cursor it was
/// given. Each push answers the next scripted outcome (a hint to poll by
/// default). Records every poll request.
#[derive(Debug, Default)]
pub struct FakeSource {
    facts: Vec<FactDecl>,
    interval_ms: Option<i64>,
    wait_ms: u64,
    polls: Mutex<VecDeque<Result<PollPage, SourceError>>>,
    pushes: Mutex<VecDeque<Result<PushOutcome, SourceError>>>,
    requests: Mutex<Vec<PollRequest>>,
}

impl FakeSource {
    pub fn new(facts: Vec<FactDecl>) -> Self {
        Self { facts, ..Self::default() }
    }

    /// It asks to be polled every `interval_ms`, each poll holding the call
    /// up to `wait_ms`.
    pub fn timed(mut self, interval_ms: Option<i64>, wait_ms: u64) -> Self {
        self.interval_ms = interval_ms;
        self.wait_ms = wait_ms;
        self
    }

    /// The next poll answers `page`.
    pub fn page(&self, page: PollPage) {
        locked(&self.polls).push_back(Ok(page));
    }

    /// The next poll fails with `error`.
    pub fn fail(&self, error: SourceError) {
        locked(&self.polls).push_back(Err(error));
    }

    /// The next push answers `outcome`.
    pub fn push_outcome(&self, outcome: Result<PushOutcome, SourceError>) {
        locked(&self.pushes).push_back(outcome);
    }

    pub fn requests(&self) -> Vec<PollRequest> {
        locked(&self.requests).clone()
    }
}

impl SignalSource for FakeSource {
    fn facts(&self) -> &[FactDecl] {
        &self.facts
    }

    fn interval_ms(&self) -> Option<i64> {
        self.interval_ms
    }

    fn wait_ms(&self) -> u64 {
        self.wait_ms
    }

    fn poll(&self, request: PollRequest) -> BoxFuture<'_, Result<PollPage, SourceError>> {
        let cursor = request.cursor.clone().unwrap_or(Value::Null);
        locked(&self.requests).push(request);
        let answer = locked(&self.polls).pop_front().unwrap_or(Ok(PollPage {
            items: Vec::new(),
            cursor,
            more: false,
            baseline: false,
            poll_after_ms: None,
            retry_at: None,
        }));
        Box::pin(std::future::ready(answer))
    }

    fn accept_push(&self, _scope: &Scope, _event: &PushEvent) -> Result<PushOutcome, SourceError> {
        locked(&self.pushes).pop_front().unwrap_or(Ok(PushOutcome::PollNow { focus: None }))
    }
}

/// The sources the test registers, by name.
#[derive(Default)]
pub struct FakeSignalSources {
    sources: HashMap<String, Arc<dyn SignalSource>>,
}

impl std::fmt::Debug for FakeSignalSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeSignalSources").field("sources", &self.sources.keys().collect::<Vec<_>>()).finish()
    }
}

impl FakeSignalSources {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, name: &str, source: Arc<dyn SignalSource>) -> Self {
        self.sources.insert(name.to_owned(), source);
        self
    }
}

impl SignalSources for FakeSignalSources {
    fn get(&self, source: &str) -> Option<Arc<dyn SignalSource>> {
        self.sources.get(source).cloned()
    }
}

/// One computer that holds every routine at epoch 1 unless the test says
/// otherwise. A claim wins at the next epoch, or fails as the test set.
/// Records adoptions, claims and reports.
#[derive(Debug)]
pub struct FakeRunner {
    device_id: String,
    holders: Mutex<HashMap<String, Holder>>,
    claim_error: Mutex<Option<RunnerError>>,
    devices: Mutex<Vec<DeviceSeen>>,
    confirmed_at: Mutex<Option<i64>>,
    adopted: Mutex<Vec<String>>,
    claimed: Mutex<Vec<String>>,
    reports: Mutex<Vec<DeviceReport>>,
}

impl FakeRunner {
    pub fn new(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_owned(),
            holders: Mutex::default(),
            claim_error: Mutex::default(),
            devices: Mutex::default(),
            confirmed_at: Mutex::default(),
            adopted: Mutex::default(),
            claimed: Mutex::default(),
            reports: Mutex::default(),
        }
    }

    pub fn set_holder(&self, routine_id: &str, holder: Holder) {
        locked(&self.holders).insert(routine_id.to_owned(), holder);
    }

    /// The next claim fails with `error`.
    pub fn fail_claim(&self, error: RunnerError) {
        *locked(&self.claim_error) = Some(error);
    }

    pub fn set_devices(&self, devices: Vec<DeviceSeen>) {
        *locked(&self.devices) = devices;
    }

    pub fn set_confirmed_at(&self, at: Option<i64>) {
        *locked(&self.confirmed_at) = at;
    }

    pub fn adopted(&self) -> Vec<String> {
        locked(&self.adopted).clone()
    }

    pub fn claimed(&self) -> Vec<String> {
        locked(&self.claimed).clone()
    }

    pub fn reports(&self) -> Vec<DeviceReport> {
        locked(&self.reports).clone()
    }

    fn epoch(&self, routine_id: &str) -> i64 {
        match locked(&self.holders).get(routine_id) {
            Some(Holder::Here { epoch } | Holder::Elsewhere { epoch, .. }) => *epoch,
            Some(Holder::Unknown) | None => 0,
        }
    }
}

impl eos_core::signals::Runner for FakeRunner {
    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn holder(&self, routine_id: &str) -> Holder {
        locked(&self.holders).get(routine_id).cloned().unwrap_or(Holder::Here { epoch: 1 })
    }

    fn adopt<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), RunnerError>> {
        locked(&self.adopted).push(routine_id.to_owned());
        self.set_holder(routine_id, Holder::Here { epoch: 1 });
        Box::pin(std::future::ready(Ok(())))
    }

    fn claim<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Handoff, RunnerError>> {
        locked(&self.claimed).push(routine_id.to_owned());
        let answer = match locked(&self.claim_error).take() {
            Some(error) => Err(error),
            None => {
                let epoch = self.epoch(routine_id) + 1;
                self.set_holder(routine_id, Holder::Here { epoch });
                Ok(Handoff { routine_id: routine_id.to_owned(), epoch, watermarks: None })
            }
        };
        Box::pin(std::future::ready(answer))
    }

    fn report<'a>(&'a self, report: &'a DeviceReport) -> BoxFuture<'a, Result<(), RunnerError>> {
        locked(&self.reports).push(report.clone());
        Box::pin(std::future::ready(Ok(())))
    }

    fn devices(&self) -> Vec<DeviceSeen> {
        locked(&self.devices).clone()
    }

    fn confirmed_at(&self) -> Option<i64> {
        *locked(&self.confirmed_at)
    }
}

#[cfg(test)]
mod tests {
    use eos_core::signals::{Runner, SignalDraft};
    use eos_domain::capability::manifest::FactType;

    use super::*;

    fn request(cursor: Option<Value>) -> PollRequest {
        PollRequest { scope: Scope::new(), cursor, wait_ms: 0, focus: None }
    }

    #[tokio::test]
    async fn a_source_answers_its_script_then_empty_pages_that_keep_the_cursor() {
        let source = FakeSource::new(vec![FactDecl { name: "repo".into(), kind: FactType::String }]);
        let draft = SignalDraft {
            key: "github:pr:acme/game#1@abc".into(),
            subject: "github:pr:acme/game#1".into(),
            version: Some("abc".into()),
            kind: "opened".into(),
            occurred_at: 5,
            facts: Default::default(),
            item: Value::Null,
        };
        let page = PollPage {
            items: vec![draft],
            cursor: serde_json::json!({"etag": "1"}),
            more: false,
            baseline: true,
            poll_after_ms: None,
            retry_at: None,
        };
        source.page(page.clone());
        source.fail(SourceError::RateLimited { retry_at: 9 });
        assert_eq!(source.poll(request(None)).await, Ok(page));
        assert_eq!(source.poll(request(None)).await, Err(SourceError::RateLimited { retry_at: 9 }));
        let empty = source.poll(request(Some(serde_json::json!("c")))).await.expect("a page");
        assert_eq!((empty.items.len(), empty.cursor), (0, serde_json::json!("c")));
        assert_eq!(source.requests().len(), 3);
        assert_eq!(source.facts()[0].name, "repo");
        source.push_outcome(Ok(PushOutcome::Refused));
        let push = PushEvent { headers: vec![], body: vec![] };
        assert_eq!(source.accept_push(&Scope::new(), &push), Ok(PushOutcome::Refused));
        assert_eq!(source.accept_push(&Scope::new(), &push), Ok(PushOutcome::PollNow { focus: None }));

        let sources = FakeSignalSources::new().with("github.pulls", Arc::new(source));
        assert!(sources.get("github.pulls").is_some() && sources.get("mail.inbox").is_none());
    }

    #[tokio::test]
    async fn a_runner_holds_everything_here_and_wins_its_claims_unless_told() {
        let runner = FakeRunner::new("dev-1");
        assert_eq!(runner.holder("rt-1"), Holder::Here { epoch: 1 });
        runner.set_holder("rt-2", Holder::Elsewhere { device_id: "dev-2".into(), epoch: 3 });
        let handoff = runner.claim("rt-2").await.expect("claims");
        assert_eq!((handoff.epoch, runner.holder("rt-2")), (4, Holder::Here { epoch: 4 }));
        runner.fail_claim(RunnerError::Lost { holder: "dev-2".into(), epoch: 5 });
        assert!(runner.claim("rt-2").await.is_err());
        runner.adopt("rt-3").await.expect("adopts");
        assert_eq!(
            (runner.device_id(), runner.adopted(), runner.claimed().len()),
            ("dev-1", vec!["rt-3".to_owned()], 2)
        );
    }
}
