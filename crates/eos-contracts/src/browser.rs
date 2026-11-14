use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{BoolLit, Num, de, yes};
use crate::validate::{Issues, Validate};

pub const GLOBAL_SESSION: &str = "global";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub tab_id: String,
    pub session_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub audible: bool,
    pub muted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub favicon_data_uri: Option<Option<String>>,
}

impl Validate for BrowserTab {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserEngineState {
    Absent,
    Launching,
    Running,
    Crashed,
    Disabled,
}

impl Validate for BrowserEngineState {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub state: BrowserEngineState,
    #[serde(deserialize_with = "de::required")]
    pub chrome_path: Option<String>,
    pub tab_count: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Validate for BrowserStatus {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserDevice {
    Responsive,
    Mobile,
    Tablet,
}

impl Validate for BrowserDevice {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserDeviceRequest {
    pub device: BrowserDevice,
}

impl Validate for BrowserDeviceRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserElement {
    pub r#ref: String,
    pub tag: String,
    pub role: String,
    pub name: String,
    pub r#box: (Num, Num, Num, Num),
    pub focusable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub locator: String,
}

impl Validate for BrowserElement {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserElementQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<(Num, Num)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<(Num, Num)>,
}

impl Validate for BrowserElementQuery {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub action: BrowserNavigateRequestAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Validate for BrowserNavigateRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserNavigateRequestAction {
    Url,
    Back,
    Forward,
    Reload,
}

impl Validate for BrowserNavigateRequestAction {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "yes")]
    pub interactive_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
}

impl Validate for BrowserSnapshotRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("depth", |cx| {
            if let Some(v) = &self.depth {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotResponse {
    pub tab_id: String,
    pub url: String,
    pub snapshot: String,
}

impl Validate for BrowserSnapshotResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub query: String,
}

impl Validate for BrowserFindRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub r#ref: String,
    pub verb: BrowserActRequestVerb,
    #[serde(default)]
    pub include_snapshot: bool,
}

impl Validate for BrowserActRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserActRequestVerb {
    Click,
    Hover,
    Focus,
    Check,
    Uncheck,
}

impl Validate for BrowserActRequestVerb {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTypeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub r#ref: String,
    pub text: String,
    #[serde(default)]
    pub submit: bool,
    #[serde(default)]
    pub include_snapshot: bool,
}

impl Validate for BrowserTypeRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFillFormRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub fields: Vec<BrowserFillFormRequestFieldsItem>,
}

impl Validate for BrowserFillFormRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserFillFormRequestFieldsItem {
    pub r#ref: String,
    pub value: String,
}

impl Validate for BrowserFillFormRequestFieldsItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPressRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub key: String,
}

impl Validate for BrowserPressRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScrollRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub direction: BrowserScrollRequestDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl Validate for BrowserScrollRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserScrollRequestDirection {
    Up,
    Down,
    Top,
    Bottom,
}

impl Validate for BrowserScrollRequestDirection {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWaitRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_ms: Option<i64>,
    #[serde(default = "browser_wait_request_timeout_ms_default")]
    pub timeout_ms: i64,
}

fn browser_wait_request_timeout_ms_default() -> i64 {
    15000
}

impl Validate for BrowserWaitRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("forMs", |cx| {
            if let Some(v) = &self.for_ms {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("timeoutMs", |cx| cx.int_min(self.timeout_ms, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGetRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub what: BrowserGetRequestWhat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl Validate for BrowserGetRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserGetRequestWhat {
    Text,
    Url,
    Title,
    Value,
}

impl Validate for BrowserGetRequestWhat {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub full_page: bool,
}

impl Validate for BrowserScreenshotRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserScreenshotResponse {
    pub path: String,
}

impl Validate for BrowserScreenshotResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvalRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub expression: String,
}

impl Validate for BrowserEvalRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabsResponse {
    pub tabs: Vec<BrowserTab>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Validate for BrowserTabsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserNewTabRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Validate for BrowserNewTabRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMuteRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub muted: bool,
}

impl Validate for BrowserMuteRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindResponse {
    pub tab_id: String,
    pub url: String,
    pub matches: Vec<BrowserElement>,
}

impl Validate for BrowserFindResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWaitResponse {
    pub ok: bool,
    pub timed_out: bool,
    pub elapsed_ms: Num,
}

impl Validate for BrowserWaitResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGetResponse {
    pub tab_id: String,
    pub what: BrowserGetResponseWhat,
    pub value: String,
}

impl Validate for BrowserGetResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserGetResponseWhat {
    Text,
    Url,
    Title,
    Value,
}

impl Validate for BrowserGetResponseWhat {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShowRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

impl Validate for BrowserShowRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShowResponse {
    pub ok: BoolLit<true>,
    pub tab_id: String,
}

impl Validate for BrowserShowResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserActivityKind {
    Use,
    Present,
}

impl Validate for BrowserActivityKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActivity {
    pub session_id: String,
    pub worker_id: String,
    pub kind: BrowserActivityKind,
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Validate for BrowserActivity {}
