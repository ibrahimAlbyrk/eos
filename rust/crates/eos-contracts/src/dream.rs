//! Port of `contracts/src/dream.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::profile::{DreamEvidence, DreamProposalKind, UserMemoryDomain};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DreamSignalObject {
    AgentBehaviour,
    UserFact,
    Artifact,
    ProjectConvention,
}

impl Validate for DreamSignalObject {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DreamSignalStance {
    GeneralRule,
    ProcessCorrection,
    TaskInstruction,
    ProductFeedback,
    Choice,
}

impl Validate for DreamSignalStance {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamSignal {
    #[serde(deserialize_with = "de::trimmed")]
    pub ask: String,
    pub object: DreamSignalObject,
    pub stance: DreamSignalStance,
    #[serde(default, deserialize_with = "de::trimmed_opt")]
    pub marker: Option<String>,
    #[serde(default, deserialize_with = "de::trimmed_opt")]
    pub reason: Option<String>,
    #[serde(default)]
    pub irreversible: bool,
    pub evidence: Vec<i64>,
}

impl Validate for DreamSignal {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ask", |cx| {
            cx.str_min(&self.ask, 1);
            cx.str_max(&self.ask, 500);
        });
        cx.at("marker", |cx| {
            if let Some(v) = &self.marker {
                cx.str_max(v, 80);
            }
        });
        cx.at("reason", |cx| {
            if let Some(v) = &self.reason {
                cx.str_max(v, 300);
            }
        });
        cx.at("evidence", |cx| {
            cx.arr_min(self.evidence.len(), 1);
            cx.arr_max(self.evidence.len(), 8);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamRecallOutput {
    pub signals: Vec<DreamSignal>,
}

impl Validate for DreamRecallOutput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("signals", |cx| {
            cx.arr_max(self.signals.len(), 12);
            self.signals.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamSupport {
    pub worker_id: String,
    pub chat: String,
    #[serde(deserialize_with = "de::required")]
    pub project: Option<String>,
    pub day: String,
    pub at: Num,
    pub stance: DreamSignalStance,
    #[serde(deserialize_with = "de::required")]
    pub marker: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub reason: Option<String>,
    pub irreversible: bool,
    pub evidence: Vec<DreamEvidence>,
}

impl Validate for DreamSupport {
    fn validate(&self, cx: &mut Issues) {
        cx.at("workerId", |cx| cx.str_min(&self.worker_id, 1));
        cx.at("day", |cx| cx.regex(&self.day, re!(r"^\d{4}-\d{2}-\d{2}$"), None));
        cx.at("evidence", |cx| {
            cx.arr_max(self.evidence.len(), 4);
            self.evidence.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamCandidate {
    pub id: String,
    #[serde(deserialize_with = "de::trimmed")]
    pub claim: String,
    pub object: DreamCandidateObject,
    #[serde(deserialize_with = "de::required")]
    pub target: Option<String>,
    pub support: Vec<DreamSupport>,
    pub first_seen: Num,
    pub last_seen: Num,
}

impl Validate for DreamCandidate {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.str_min(&self.id, 1));
        cx.at("claim", |cx| {
            cx.str_min(&self.claim, 1);
            cx.str_max(&self.claim, 500);
        });
        cx.at("support", |cx| {
            cx.arr_min(self.support.len(), 1);
            cx.arr_max(self.support.len(), 24);
            self.support.validate(cx);
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DreamCandidateObject {
    AgentBehaviour,
    UserFact,
}

impl Validate for DreamCandidateObject {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamMatchGroup {
    pub signals: Vec<i64>,
    #[serde(default)]
    pub candidate: Option<String>,
    #[serde(default)]
    pub memory: Option<String>,
    #[serde(default)]
    pub contradicts: bool,
    #[serde(default, deserialize_with = "de::trimmed_opt")]
    pub claim: Option<String>,
}

impl Validate for DreamMatchGroup {
    fn validate(&self, cx: &mut Issues) {
        cx.at("signals", |cx| {
            cx.arr_min(self.signals.len(), 1);
            for (i, v) in self.signals.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
        cx.at("claim", |cx| {
            if let Some(v) = &self.claim {
                cx.str_max(v, 500);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamMatchOutput {
    pub groups: Vec<DreamMatchGroup>,
}

impl Validate for DreamMatchOutput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("groups", |cx| {
            cx.arr_max(self.groups.len(), 100);
            self.groups.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamDropped {
    #[serde(default)]
    pub one_off: i64,
    #[serde(default)]
    pub known: i64,
    #[serde(default)]
    pub declined: i64,
    #[serde(default)]
    pub secret: i64,
    #[serde(default)]
    pub weak: i64,
    #[serde(default)]
    pub invalid: i64,
    #[serde(default)]
    pub product: i64,
    #[serde(default)]
    pub task_bound: i64,
    #[serde(default)]
    pub choice: i64,
    #[serde(default)]
    pub critic: i64,
    #[serde(default)]
    pub style: i64,
    #[serde(default)]
    pub capped: i64,
}

impl Validate for DreamDropped {
    fn validate(&self, cx: &mut Issues) {
        cx.at("oneOff", |cx| cx.int_min(self.one_off, 0, true));
        cx.at("known", |cx| cx.int_min(self.known, 0, true));
        cx.at("declined", |cx| cx.int_min(self.declined, 0, true));
        cx.at("secret", |cx| cx.int_min(self.secret, 0, true));
        cx.at("weak", |cx| cx.int_min(self.weak, 0, true));
        cx.at("invalid", |cx| cx.int_min(self.invalid, 0, true));
        cx.at("product", |cx| cx.int_min(self.product, 0, true));
        cx.at("taskBound", |cx| cx.int_min(self.task_bound, 0, true));
        cx.at("choice", |cx| cx.int_min(self.choice, 0, true));
        cx.at("critic", |cx| cx.int_min(self.critic, 0, true));
        cx.at("style", |cx| cx.int_min(self.style, 0, true));
        cx.at("capped", |cx| cx.int_min(self.capped, 0, true));
    }
}

pub const DREAM_PROPOSALS_MAX: i64 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamProposalDraft {
    pub candidate: String,
    pub kind: DreamProposalKind,
    #[serde(deserialize_with = "de::trimmed")]
    pub text: String,
    pub category: DreamProposalDraftCategory,
    pub domain: UserMemoryDomain,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(deserialize_with = "de::trimmed")]
    pub why: String,
}

impl Validate for DreamProposalDraft {
    fn validate(&self, cx: &mut Issues) {
        cx.at("candidate", |cx| cx.str_min(&self.candidate, 1));
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 500);
        });
        cx.at("targets", |cx| cx.arr_max(self.targets.len(), 6));
        cx.at("why", |cx| {
            cx.str_min(&self.why, 1);
            cx.str_max(&self.why, 300);
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DreamProposalDraftCategory {
    About,
    WorkStyle,
    Stack,
}

impl Validate for DreamProposalDraftCategory {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamSetAside {
    pub candidate: String,
    pub why: DreamSetAsideWhy,
}

impl Validate for DreamSetAside {
    fn validate(&self, cx: &mut Issues) {
        cx.at("candidate", |cx| cx.str_min(&self.candidate, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DreamSetAsideWhy {
    Known,
    Declined,
    OneOff,
    Product,
    Weak,
}

impl Validate for DreamSetAsideWhy {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamConsolidateOutput {
    #[serde(default, deserialize_with = "de::trimmed")]
    pub narrative: String,
    pub proposals: Vec<DreamProposalDraft>,
    #[serde(default)]
    pub set_aside: Vec<DreamSetAside>,
}

impl Validate for DreamConsolidateOutput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("narrative", |cx| cx.str_max(&self.narrative, 700));
        cx.at("proposals", |cx| {
            cx.arr_max(self.proposals.len(), 3);
            self.proposals.validate(cx);
        });
        cx.at("setAside", |cx| {
            cx.arr_max(self.set_aside.len(), 100);
            self.set_aside.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamVerdict {
    pub proposal: i64,
    pub keep: bool,
    #[serde(default)]
    pub fails: Vec<i64>,
    #[serde(default)]
    pub quotes: Vec<DreamVerdictQuotesItem>,
    #[serde(default, deserialize_with = "de::trimmed")]
    pub reason: String,
}

impl Validate for DreamVerdict {
    fn validate(&self, cx: &mut Issues) {
        cx.at("proposal", |cx| cx.int_min(self.proposal, 0, true));
        cx.at("fails", |cx| {
            cx.arr_max(self.fails.len(), 5);
            for (i, v) in self.fails.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.int_min(*v, 1, true);
                    cx.int_max(*v, 5, true);
                });
            }
        });
        cx.at("quotes", |cx| cx.arr_max(self.quotes.len(), 8));
        cx.at("reason", |cx| cx.str_max(&self.reason, 300));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamVerdictQuotesItem {
    pub event_id: i64,
    pub says: DreamVerdictQuotesItemSays,
}

impl Validate for DreamVerdictQuotesItem {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamVerdictQuotesItemSays {
    Yes,
    Topical,
    No,
}

impl Validate for DreamVerdictQuotesItemSays {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamCriticOutput {
    pub verdicts: Vec<DreamVerdict>,
}

impl Validate for DreamCriticOutput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("verdicts", |cx| {
            cx.arr_max(self.verdicts.len(), 3);
            self.verdicts.validate(cx);
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamTrigger {
    Nightly,
    Away,
    Manual,
}

impl Validate for DreamTrigger {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamRunStatus {
    Running,
    Done,
    Skipped,
    Failed,
    Stopped,
}

impl Validate for DreamRunStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamRejected {
    pub text: String,
    pub reason: String,
}

impl Validate for DreamRejected {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_max(&self.text, 500));
        cx.at("reason", |cx| cx.str_max(&self.reason, 300));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamChatRead {
    pub worker_id: String,
    pub name: String,
    #[serde(deserialize_with = "de::required")]
    pub project: Option<String>,
    pub user_turns: i64,
    pub observations: i64,
}

impl Validate for DreamChatRead {
    fn validate(&self, cx: &mut Issues) {
        cx.at("userTurns", |cx| cx.int_min(self.user_turns, 0, true));
        cx.at("observations", |cx| cx.int_min(self.observations, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamRun {
    pub id: String,
    pub trigger: DreamTrigger,
    pub status: DreamRunStatus,
    #[serde(deserialize_with = "de::required")]
    pub reason: Option<String>,
    pub started_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub finished_at: Option<Num>,
    pub model: String,
    pub chats_read: i64,
    pub observations: i64,
    pub proposed: i64,
    pub tokens: i64,
    #[serde(deserialize_with = "de::required")]
    pub narrative: Option<String>,
    pub dropped: DreamDropped,
    pub chats: Vec<DreamChatRead>,
    #[serde(default)]
    pub candidates: i64,
    #[serde(default)]
    pub rejected: Vec<DreamRejected>,
}

impl Validate for DreamRun {
    fn validate(&self, cx: &mut Issues) {
        cx.at("chatsRead", |cx| cx.int_min(self.chats_read, 0, true));
        cx.at("observations", |cx| cx.int_min(self.observations, 0, true));
        cx.at("proposed", |cx| cx.int_min(self.proposed, 0, true));
        cx.at("tokens", |cx| cx.int_min(self.tokens, 0, true));
        cx.at("dropped", |cx| self.dropped.validate(cx));
        cx.at("chats", |cx| self.chats.validate(cx));
        cx.at("candidates", |cx| cx.int_min(self.candidates, 0, true));
        cx.at("rejected", |cx| {
            cx.arr_max(self.rejected.len(), 12);
            self.rejected.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamListResponse {
    pub runs: Vec<DreamRun>,
    pub excluded: Vec<String>,
}

impl Validate for DreamListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("runs", |cx| self.runs.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DreamProgress {
    pub done: i64,
    pub total: i64,
    #[serde(deserialize_with = "de::required")]
    pub chat: Option<String>,
    pub noticed: Vec<String>,
}

impl Validate for DreamProgress {
    fn validate(&self, cx: &mut Issues) {
        cx.at("done", |cx| cx.int_min(self.done, 0, true));
        cx.at("total", |cx| cx.int_min(self.total, 0, true));
        cx.at("noticed", |cx| cx.arr_max(self.noticed.len(), 6));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DreamBlock {
    Disabled,
    SignIn,
    Usage,
}

impl Validate for DreamBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamStatus {
    pub running: bool,
    #[serde(deserialize_with = "de::required")]
    pub run_id: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub progress: Option<DreamProgress>,
    #[serde(deserialize_with = "de::required")]
    pub last_run: Option<DreamRun>,
    #[serde(deserialize_with = "de::required")]
    pub next_at: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub blocked: Option<DreamBlock>,
}

impl Validate for DreamStatus {
    fn validate(&self, cx: &mut Issues) {
        cx.at("progress", |cx| {
            if let Some(v) = &self.progress {
                v.validate(cx);
            }
        });
        cx.at("lastRun", |cx| {
            if let Some(v) = &self.last_run {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamExclusionRequest {
    pub worker_id: String,
    pub excluded: bool,
}

impl Validate for DreamExclusionRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("workerId", |cx| cx.str_min(&self.worker_id, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamChangeEvent {
    #[serde(deserialize_with = "de::required")]
    pub run_id: Option<String>,
    pub status: DreamRunStatus,
}

impl Validate for DreamChangeEvent {}
