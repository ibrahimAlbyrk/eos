//! The wire records of visual answers: port of the schemas in `contracts/src/genui/spec.ts`
//! (route bodies, stored views, bus payloads). A stored `spec` and a `Place` are plain
//! JSON here: the tool inputs, the catalog, the parsers and `validate_view` are `eos-genui`'s.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{Num, de, str_lit};
use crate::validate::{Issues, Validate, re};

str_lit!(pub EmptyLit = "");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ViewId(pub String);

impl Validate for ViewId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^v_[A-Za-z0-9]{12}$"), Some("must be a view id (v_ + 12 letters/digits)"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    View,
    App,
}

impl Validate for ViewKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ViewRecord {
    View(ViewRecordView),
    App(ViewRecordApp),
}

impl Validate for ViewRecord {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::View(v) => v.validate(cx),
            Self::App(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewRecordView {
    pub id: ViewId,
    pub worker_id: String,
    pub title: String,
    pub created_at: Num,
    pub spec: Value,
}

impl Validate for ViewRecordView {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("workerId", |cx| cx.str_min(&self.worker_id, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewRecordApp {
    pub id: ViewId,
    pub worker_id: String,
    pub title: String,
    pub created_at: Num,
    pub spec: Value,
}

impl Validate for ViewRecordApp {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("workerId", |cx| cx.str_min(&self.worker_id, 1));
    }
}

/// The UI state of a view (filters, inputs): any JSON object up to 32 KB.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ViewState(pub IndexMap<String, Value>);

pub const VIEW_STATE_MAX_BYTES: usize = 32 * 1024;

impl Validate for ViewState {
    fn validate(&self, cx: &mut Issues) {
        if serde_json::to_string(&self.0).map_or(usize::MAX, |json| json.len()) > VIEW_STATE_MAX_BYTES {
            cx.push("view state is larger than 32 KB");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewAction {
    pub view_id: ViewId,
    pub action_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<ViewActionItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ViewState>,
}

impl Validate for ViewAction {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
        cx.at("actionId", |cx| {
            cx.str_min(&self.action_id, 1);
            cx.str_max(&self.action_id, 64);
        });
        cx.at("label", |cx| {
            cx.str_min(&self.label, 1);
            cx.str_max(&self.label, 200);
        });
        cx.at("viewTitle", |cx| {
            if let Some(v) = &self.view_title {
                cx.str_max(v, 200);
            }
        });
        cx.at("item", |cx| {
            if let Some(v) = &self.item {
                v.validate(cx);
            }
        });
        cx.at("state", |cx| {
            if let Some(v) = &self.state {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ViewActionItem {
    Text(String),
    Number(Num),
    Map(IndexMap<String, Value>),
}

impl Validate for ViewActionItem {
    fn validate(&self, cx: &mut Issues) {
        if let Self::Text(v) = self {
            cx.str_max(v, 200);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageAction {
    pub view_id: ViewId,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_title: Option<String>,
}

impl Validate for UserMessageAction {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenuiDelta {
    pub worker_id: String,
    pub call_id: String,
    pub name: String,
    pub phase: GenuiDeltaPhase,
    pub text: String,
}

impl Validate for GenuiDelta {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GenuiDeltaPhase {
    Start,
    Append,
    Stop,
}

impl Validate for GenuiDeltaPhase {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenuiChange {
    pub view_id: ViewId,
    pub state: ViewState,
}

impl Validate for GenuiChange {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
        cx.at("state", |cx| self.state.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ViewProblem {
    pub path: String,
    pub message: String,
}

impl Validate for ViewProblem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewStats {
    pub ui_bytes: Num,
    pub data_bytes: Num,
    pub elements: Num,
    pub depth: Num,
    pub components: Vec<String>,
    pub collections: Vec<ViewStatsCollectionsItem>,
    pub images: Num,
    pub sites: Num,
    pub maps: Num,
    pub primary_actions: Num,
}

impl Validate for ViewStats {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ViewStatsCollectionsItem {
    pub name: String,
    pub count: Num,
    #[serde(deserialize_with = "de::required")]
    pub r#type: Option<String>,
}

impl Validate for ViewStatsCollectionsItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CreateViewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub input: Option<Value>,
}

impl Validate for CreateViewRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateViewResponse {
    pub view_id: ViewId,
    pub warnings: Vec<ViewProblem>,
    pub stats: ViewStats,
}

impl Validate for CreateViewResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GenuiRejection {
    pub error: String,
    pub problems: Vec<ViewProblem>,
}

impl Validate for GenuiRejection {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CreateAppRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub input: Option<Value>,
}

impl Validate for CreateAppRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAppResponse {
    pub view_id: ViewId,
    pub warnings: Vec<ViewProblem>,
}

impl Validate for CreateAppResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewStateResponse {
    pub view_id: ViewId,
    pub state: ViewState,
    #[serde(deserialize_with = "de::required")]
    pub updated_at: Option<Num>,
}

impl Validate for ViewStateResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("viewId", |cx| self.view_id.validate(cx));
        cx.at("state", |cx| self.state.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PutViewStateRequest {
    pub state: ViewState,
}

impl Validate for PutViewStateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("state", |cx| self.state.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MediaImgQuery {
    pub src: String,
}

impl Validate for MediaImgQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("src", |cx| {
            cx.url(&self.src);
            cx.str_max(&self.src, 2048);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MediaOgQuery {
    pub url: String,
}

impl Validate for MediaOgQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("url", |cx| {
            cx.url(&self.url);
            cx.str_max(&self.url, 2048);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MediaIconQuery {
    pub site: String,
}

impl Validate for MediaIconQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("site", |cx| {
            cx.str_min(&self.site, 1);
            cx.str_max(&self.site, 253);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LatLon {
    pub lat: Num,
    pub lon: Num,
}

impl Validate for LatLon {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lat", |cx| {
            cx.num_min(self.lat, -90.0, true);
            cx.num_max(self.lat, 90.0, true);
        });
        cx.at("lon", |cx| {
            cx.num_min(self.lon, -180.0, true);
            cx.num_max(self.lon, 180.0, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Area {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub district: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}

impl Validate for Area {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GeocodeQuery {
    pub q: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_int_opt")]
    pub limit: Option<i64>,
}

impl Validate for GeocodeQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("q", |cx| {
            cx.str_min(&self.q, 1);
            cx.str_max(&self.q, 300);
        });
        cx.at("limit", |cx| {
            if let Some(v) = &self.limit {
                cx.int_min(*v, 1, true);
                cx.int_max(*v, 10, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GeocodeResult {
    pub lat: Num,
    pub lon: Num,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Area>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl Validate for GeocodeResult {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lat", |cx| {
            cx.num_min(self.lat, -90.0, true);
            cx.num_max(self.lat, 90.0, true);
        });
        cx.at("lon", |cx| {
            cx.num_min(self.lon, -180.0, true);
            cx.num_max(self.lon, 180.0, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GeocodeResponse {
    pub results: Vec<GeocodeResult>,
    pub attribution: String,
}

impl Validate for GeocodeResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("results", |cx| self.results.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlacesRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub near: PlacesRequestNear,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_m: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

impl Validate for PlacesRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("query", |cx| {
            if let Some(v) = &self.query {
                cx.str_min(v, 1);
                cx.str_max(v, 200);
            }
        });
        cx.at("category", |cx| {
            if let Some(v) = &self.category {
                cx.str_min(v, 1);
                cx.str_max(v, 60);
            }
        });
        cx.at("near", |cx| self.near.validate(cx));
        cx.at("radiusM", |cx| {
            if let Some(v) = &self.radius_m {
                cx.int_min(*v, 50, true);
                cx.int_max(*v, 20000, true);
            }
        });
        cx.at("limit", |cx| {
            if let Some(v) = &self.limit {
                cx.int_min(*v, 1, true);
                cx.int_max(*v, 40, true);
            }
        });
        let given = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
        if !(given(&self.query) || given(&self.category)) {
            cx.push("query or category is required");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PlacesRequestNear {
    LatLon(LatLon),
    Text(PlacesRequestNearText),
}

impl Validate for PlacesRequestNear {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::LatLon(v) => v.validate(cx),
            Self::Text(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlacesRequestNearText {
    pub text: String,
}

impl Validate for PlacesRequestNearText {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 300);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlacesResponse {
    pub places: Vec<Value>,
    pub attribution: String,
}

impl Validate for PlacesResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocationFix {
    pub lat: Num,
    pub lon: Num,
    pub accuracy: Num,
    pub at: Num,
}

impl Validate for LocationFix {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lat", |cx| {
            cx.num_min(self.lat, -90.0, true);
            cx.num_max(self.lat, 90.0, true);
        });
        cx.at("lon", |cx| {
            cx.num_min(self.lon, -180.0, true);
            cx.num_max(self.lon, 180.0, true);
        });
        cx.at("accuracy", |cx| cx.num_min(self.accuracy, 0.0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocationResponse {
    pub lat: Num,
    pub lon: Num,
    pub accuracy: Num,
    pub at: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Area>,
}

impl Validate for LocationResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lat", |cx| {
            cx.num_min(self.lat, -90.0, true);
            cx.num_max(self.lat, 90.0, true);
        });
        cx.at("lon", |cx| {
            cx.num_min(self.lon, -180.0, true);
            cx.num_max(self.lon, 180.0, true);
        });
        cx.at("accuracy", |cx| cx.num_min(self.accuracy, 0.0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GenuiLevel {
    Rich,
    Balanced,
    Text,
}

impl Validate for GenuiLevel {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct LogoDevKey(pub String);

impl Validate for LogoDevKey {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^pk_[A-Za-z0-9_-]{4,200}$"), Some("must be a logo.dev publishable key (pk_…)"));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenuiConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_dev_key: Option<LogoDevKey>,
}

impl Validate for GenuiConfig {
    fn validate(&self, cx: &mut Issues) {
        cx.at("logoDevKey", |cx| {
            if let Some(v) = &self.logo_dev_key {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenuiSettings {
    pub level: GenuiLevel,
    pub apps: bool,
    pub location_share: bool,
    #[serde(deserialize_with = "de::required")]
    pub logo_dev_key: Option<String>,
}

impl Validate for GenuiSettings {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenuiSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<GenuiLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_share: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_dev_key: Option<GenuiSettingsPatchLogoDevKey>,
}

impl Validate for GenuiSettingsPatch {
    fn validate(&self, cx: &mut Issues) {
        cx.at("logoDevKey", |cx| {
            if let Some(v) = &self.logo_dev_key {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum GenuiSettingsPatchLogoDevKey {
    LogoDevKey(LogoDevKey),
    Empty(EmptyLit),
    Null,
}

impl Validate for GenuiSettingsPatchLogoDevKey {
    fn validate(&self, cx: &mut Issues) {
        // Reading tries the variants in order, so `""` arrives as a key: it is
        // the union's second member, which clears the key.
        if let Self::LogoDevKey(v) = self
            && !v.0.is_empty()
        {
            v.validate(cx);
        }
    }
}

pub const GENUI_OFF_TEXT: &str = "Visual answers are off — answer in text";
