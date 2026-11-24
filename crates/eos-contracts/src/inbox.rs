//! What the Needs-you routes take and answer, and what `inbox:change`,
//! `inbox:delivery`, `inbox:freedom` and `inbox:halt` carry. Kinds, states and
//! attention levels travel as the words `eos_domain::inbox` stores; results
//! and their edits are `result_doc`'s shapes. Titles, summaries, payloads and
//! drafts are the user's: these types are never logged.

mod deliveries;

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::result_doc::ResultDoc;
use crate::validate::Validate;

pub use deliveries::*;

/// A row of `GET /api/inbox`: one thing that waits for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    /// `draft`, `run_start`, `question`, `permission`, `capability_install`,
    /// `capability_attention`, `about_you`, `routine_alert`, `freedom_offer`,
    /// `confirm_change`, `delivery_problem`, `suggestion` or `notice`.
    pub kind: String,
    /// `open`, `later`, `answered`, `replaced`, `expired` or `withdrawn`.
    pub state: String,
    /// `interrupt`, `digest` or `silent`.
    pub attention: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub title: String,
    pub summary: String,
    /// An answer or a saved edit names the rev it was made on.
    pub rev: i64,
    /// Its subject moved on since it was made: sending needs a second yes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub later_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The routine's View it shows: a card or a question drawn from that
    /// issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ItemView>,
}

/// The issue a View's item is drawn from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub surface_id: String,
    pub issue_id: String,
}

impl Validate for ItemView {}

impl Validate for InboxItem {}

/// `GET /api/inbox/{id}`: the item with what its kind carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InboxItemDetail {
    pub item: InboxItem,
    /// What its kind carries: a draft's result, a run's questions.
    pub payload: Value,
    /// The user's saved edits of a draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working: Option<ResultDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
    /// `dashboard`, `phone`, `peer` or `system`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
    /// The answer as it was given: an [`InboxAnswer`], or a draft's send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Value>,
    /// The newer item that took its place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
    /// A draft's sends, newest last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deliveries: Vec<DraftDelivery>,
}

impl Validate for InboxItemDetail {}

/// `GET /api/inbox`: one page of items, in Needs you's order, with the counts
/// of every item that waits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InboxList {
    pub items: Vec<InboxItem>,
    pub counts: InboxCounts,
    /// Open asks and questions of Agents chats, which are not items.
    pub agents_waiting: i64,
    /// Asks for the next page; none on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl Validate for InboxList {}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InboxCounts {
    pub open: i64,
    pub later: i64,
    /// Items that wait, by kind.
    pub by_kind: IndexMap<String, i64>,
    /// Items that wait, by routine id.
    pub by_routine: IndexMap<String, i64>,
}

impl Validate for InboxCounts {}

/// `PUT /api/inbox/{id}/draft`: keep the user's edits of a draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DraftSave {
    pub rev: i64,
    pub doc: ResultDoc,
}

impl Validate for DraftSave {}

/// `POST /api/inbox/{id}/later`: put an item aside.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct LaterRequest {
    /// Back then (epoch ms); none puts it aside until the next digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

impl Validate for LaterRequest {}

/// `POST /api/inbox/{id}/discard`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DiscardRequest {
    pub rev: i64,
}

impl Validate for DiscardRequest {}

/// `POST /api/inbox/{id}/send`: send a draft, as it is or edited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub rev: i64,
    /// The whole result as the user edited it; none sends the draft as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<ResultDoc>,
    /// The user saw that its subject moved on, and sends it anyway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_stale: Option<bool>,
}

impl Validate for SendRequest {}

/// What `POST /api/inbox/{id}/send` answers: one delivery per target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SendAnswer {
    pub deliveries: Vec<DeliveryRef>,
}

impl Validate for SendAnswer {}

/// `POST /api/inbox/{id}/answer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AnswerRequest {
    pub rev: i64,
    pub answer: InboxAnswer,
}

impl Validate for AnswerRequest {}

/// The user's answer to an item, by the item's kind. A draft is answered by
/// send or discard, a run's permission ask and an about-you suggestion by
/// their own recorded routes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InboxAnswer {
    RunStart {
        choice: RunStartChoice,
    },
    /// By question, as a chat's questions are answered.
    Question {
        answers: IndexMap<String, String>,
    },
    CapabilityInstall {
        choice: InstallChoice,
    },
    RoutineAlert {
        choice: AlertChoice,
    },
    FreedomOffer {
        choice: OfferChoice,
    },
    ConfirmChange {
        choice: ConfirmChoice,
    },
    DeliveryProblem {
        choice: ProblemChoice,
        /// The result as the user edited it before trying again.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        doc: Option<ResultDoc>,
    },
    Suggestion {
        choice: SuggestionChoice,
    },
    Notice {
        choice: NoticeChoice,
    },
}

impl Validate for InboxAnswer {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStartChoice {
    Run,
    Skip,
}

impl Validate for RunStartChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallChoice {
    Install,
    Decline,
}

impl Validate for InstallChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AlertChoice {
    Resume,
    KeepPaused,
}

impl Validate for AlertChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OfferChoice {
    Accept,
    NotNow,
    /// No more offers until the user changes the routine's Freedom.
    Never,
}

impl Validate for OfferChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmChoice {
    Confirm,
    Reject,
}

impl Validate for ConfirmChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProblemChoice {
    Retry,
    /// The user sent it some other way.
    MarkSent,
    Discard,
}

impl Validate for ProblemChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionChoice {
    MakeIt,
    No,
}

impl Validate for SuggestionChoice {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NoticeChoice {
    /// The one action the notice offers.
    Act,
    Dismiss,
}

impl Validate for NoticeChoice {}

/// `inbox:change`: an item was made, answered or changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InboxChange {
    pub id: String,
    pub kind: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    pub rev: i64,
    /// How many items are open now.
    pub open: i64,
}

impl Validate for InboxChange {}

#[cfg(test)]
mod tests;
