//! What the delivery, Freedom, stop-switch and attention routes take and
//! answer, and the `inbox:delivery`, `inbox:freedom` and `inbox:halt`
//! payloads.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::freedom::{ActionClass, Grant, Rung};
use crate::result_doc::ResultDoc;
use crate::validate::{Issues, Validate, re};

/// `GET /api/inbox/deliveries/{id}`: one result on its way to one target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    /// The item it was approved from; none for one Freedom sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub run_id: String,
    pub routine_id: String,
    pub channel: String,
    pub action: String,
    /// The id of the Goes-to recipient it goes to.
    pub target_ref: String,
    pub class: ActionClass,
    /// `approved`, `auto` or `grant:<id>`.
    pub mode: String,
    /// `queued`, `holding`, `sending`, `sent`, `undone`, `failed`,
    /// `uncertain`, `stopped`, `frozen` or `waiting_capability`.
    pub state: String,
    pub body: ResultDoc,
    /// It goes no earlier: the end of its hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
    pub attempts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_kind: Option<String>,
    /// Where the user sees what went out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<i64>,
    /// It can be taken back until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Validate for Delivery {}

/// A delivery by id, and where it stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRef {
    pub id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
}

impl Validate for DeliveryRef {}

/// `inbox:delivery`: a delivery moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryChange {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub run_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
}

impl Validate for DeliveryChange {}

/// `GET /api/routines/{id}/freedom`: how far the routine's results go
/// without the user, as the user confirmed it, and what it earned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FreedomView {
    pub routine_id: String,
    pub rung: Rung,
    pub grants: Vec<Grant>,
    /// Results in a row the user sent as they were.
    pub streak: i64,
    /// `none`, `offered`, `declined` or `never`.
    pub offer: String,
    /// The open offer's item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer_item_id: Option<String>,
}

impl Validate for FreedomView {}

/// `inbox:freedom`: a routine's rung, streak or offer changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FreedomChange {
    pub routine_id: String,
    pub rung: Rung,
    pub streak: i64,
    pub offer: String,
}

impl Validate for FreedomChange {}

/// `GET /api/eos/halt`, and `inbox:halt`: whether every routine on this
/// computer is stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HaltState {
    pub on: bool,
    /// When it was switched on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

impl Validate for HaltState {}

/// `GET` and `PUT /api/settings/attention`: when Needs you may interrupt.
/// Times are `HH:MM` on this computer's clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSettings {
    pub quiet_on: bool,
    pub quiet_from: String,
    pub quiet_to: String,
    /// When the banners that count what waits come.
    pub digests: Vec<String>,
    pub interrupts: Interrupts,
}

impl Validate for AttentionSettings {
    fn validate(&self, cx: &mut Issues) {
        let time = re!(r"^([01]\d|2[0-3]):[0-5]\d$");
        cx.at("quietFrom", |cx| cx.regex(&self.quiet_from, time, Some("HH:MM")));
        cx.at("quietTo", |cx| cx.regex(&self.quiet_to, time, Some("HH:MM")));
        cx.at("digests", |cx| {
            for (i, at) in self.digests.iter().enumerate() {
                cx.idx(i, |cx| cx.regex(at, time, Some("HH:MM")));
            }
        });
    }
}

/// Which items may interrupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Interrupts {
    All,
    Urgent,
    None,
}

impl Validate for Interrupts {}
