//! Shapes that cross a boundary: the click a view sends back, a view's UI state,
//! the streaming delta, and the settings that switch visual answers.
//!
//! Each type accepts what the dashboard's schema accepts: an optional field may
//! be absent but not `null`, unknown fields are ignored, lengths count UTF-16
//! code units, and the limits are checked while reading.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::catalog::GENUI_LIMITS;
use crate::js::len16;
use crate::spec::ViewId;
use crate::value::{Object, Value};

// `.optional()`: absent is fine, null is not.
fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn bounded<E: de::Error>(field: &str, s: &str, min: usize, max: usize) -> Result<(), E> {
    let len = len16(s);
    if len < min || len > max {
        Err(E::custom(format!("{field} must be {min}–{max} characters, got {len}")))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    View,
    App,
}

/// Per-instance UI state (filters, ticks, the current step): a plain JSON object
/// of at most 32 KB as `JSON.stringify` prints it.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(transparent)]
pub struct ViewState(Object);

impl ViewState {
    pub fn new(state: Object) -> Result<Self, String> {
        let bytes = crate::js::object_json_bytes(&state);
        if bytes > GENUI_LIMITS.state_bytes {
            return Err(format!("view state is larger than {} KB", GENUI_LIMITS.state_bytes / 1024));
        }
        Ok(ViewState(state))
    }

    pub fn as_object(&self) -> &Object {
        &self.0
    }

    pub fn into_object(self) -> Object {
        self.0
    }
}

impl<'de> Deserialize<'de> for ViewState {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        ViewState::new(Object::deserialize(d)?).map_err(de::Error::custom)
    }
}

/// The item a send action was clicked on: its id, or the item itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ViewActionItem {
    Id(String),
    Number(f64),
    Item(Object),
}

impl<'de> Deserialize<'de> for ViewActionItem {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::String(id) => bounded("item", &id, 0, 200).map(|()| ViewActionItem::Id(id)),
            Value::Number(n) => Ok(ViewActionItem::Number(n)),
            Value::Object(item) => Ok(ViewActionItem::Item(item)),
            _ => Err(de::Error::custom("item must be an id, a number or an object")),
        }
    }
}

/// A click on a send action, carried on a message beside its text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "RawViewAction")]
pub struct ViewAction {
    pub view_id: ViewId,
    pub action_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<ViewActionItem>,
    /// The view's state at the click.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ViewState>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawViewAction {
    view_id: ViewId,
    action_id: String,
    label: String,
    #[serde(default, deserialize_with = "present")]
    view_title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    item: Option<ViewActionItem>,
    #[serde(default, deserialize_with = "present")]
    state: Option<ViewState>,
}

impl TryFrom<RawViewAction> for ViewAction {
    type Error = String;

    fn try_from(raw: RawViewAction) -> Result<Self, String> {
        let check = |field: &str, s: &str, min: usize, max: usize| {
            bounded::<de::value::Error>(field, s, min, max).map_err(|e| e.to_string())
        };
        check("actionId", &raw.action_id, 1, 64)?;
        check("label", &raw.label, 1, 200)?;
        if let Some(title) = &raw.view_title {
            check("viewTitle", title, 0, 200)?;
        }
        Ok(ViewAction {
            view_id: raw.view_id,
            action_id: raw.action_id,
            label: raw.label,
            view_title: raw.view_title,
            item: raw.item,
            state: raw.state,
        })
    }
}

/// What the stored user message keeps of a click (the chat shows `label` as the reply chip).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageAction {
    pub view_id: ViewId,
    pub label: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub view_title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GenuiPhase {
    Start,
    Append,
    Stop,
}

/// Bus topic "genui:delta": the raw input text of a present call while the model
/// writes it. start (text "") → append… → stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenuiDelta {
    pub worker_id: String,
    pub call_id: String,
    /// The tool's full name, e.g. "mcp__orchestrator__present".
    pub name: String,
    pub phase: GenuiPhase,
    pub text: String,
}

/// Bus topic "genui:change": a view's state was replaced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenuiChange {
    pub view_id: ViewId,
    pub state: ViewState,
}

pub const TOPIC_DELTA: &str = "genui:delta";
pub const TOPIC_CHANGE: &str = "genui:change";

/// How readily agents answer with a view (settings key `genui.level`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GenuiLevel {
    Rich,
    #[default]
    Balanced,
    Text,
}

/// settings.json keys; `location.share` is writable only through the genui settings route.
pub const SETTING_LEVEL: &str = "genui.level";
pub const SETTING_APPS: &str = "genui.apps";
pub const SETTING_LOCATION_SHARE: &str = "location.share";
pub const DEFAULT_APPS: bool = true;
pub const DEFAULT_LOCATION_SHARE: bool = true;
