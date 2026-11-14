use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{IntLit, de, str_lit};
use crate::validate::{Issues, Validate};

str_lit!(pub EventLit = "event");
str_lit!(pub PatchLit = "patch");
str_lit!(pub SnapshotLit = "snapshot");
str_lit!(pub RowsLit = "rows");
str_lit!(pub AssetLit = "asset");
str_lit!(pub EosPairLit = "eos-pair");

pub const DEFAULT_RELAY_URL: &str = "wss://silver-giraffe-71764.zap.cloud/";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RemoteConfigRelay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inactivity_lease_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RemoteConfigRateLimit>,
}

impl Validate for RemoteConfig {
    fn validate(&self, cx: &mut Issues) {
        cx.at("relay", |cx| {
            if let Some(v) = &self.relay {
                v.validate(cx);
            }
        });
        cx.at("inactivityLeaseMs", |cx| {
            if let Some(v) = &self.inactivity_lease_ms {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("rateLimit", |cx| {
            if let Some(v) = &self.rate_limit {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RemoteConfigRelay {
    pub url: String,
}

impl Validate for RemoteConfigRelay {
    fn validate(&self, cx: &mut Issues) {
        cx.at("url", |cx| cx.url(&self.url));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigRateLimit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_device_per_min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_per_min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing_per_min: Option<i64>,
}

impl Validate for RemoteConfigRateLimit {
    fn validate(&self, cx: &mut Issues) {
        cx.at("perDevicePerMin", |cx| {
            if let Some(v) = &self.per_device_per_min {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("globalPerMin", |cx| {
            if let Some(v) = &self.global_per_min {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("pairingPerMin", |cx| {
            if let Some(v) = &self.pairing_per_min {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

pub const REMOTE_CAPS: &[&str] = &["focus", "rows", "deflate"];

pub const DEFLATE_MARK: i64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelloFrame {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub last_content_id: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<Vec<String>>,
}

impl Validate for HelloFrame {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lastContentId", |cx| {
            if let Some(Some(v)) = &self.last_content_id {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("caps", |cx| {
            if let Some(v) = &self.caps {
                cx.arr_max(v.len(), 16);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FocusFrame {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub worker: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub after_id: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub pty: Option<Option<String>>,
}

impl Validate for FocusFrame {
    fn validate(&self, cx: &mut Issues) {
        cx.at("afterId", |cx| {
            if let Some(Some(v)) = &self.after_id {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ControlFrame {
    pub correlation_id: String,
    pub method: ControlFrameMethod,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

impl Validate for ControlFrame {
    fn validate(&self, cx: &mut Issues) {
        cx.at("correlationId", |cx| cx.uuid(&self.correlation_id));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum ControlFrameMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl Validate for ControlFrameMethod {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct KaFrame {
    pub ts: i64,
}

impl Validate for KaFrame {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SubFrame {
    pub pty: Vec<String>,
}

impl Validate for SubFrame {
    fn validate(&self, cx: &mut Issues) {
        cx.at("pty", |cx| cx.arr_max(self.pty.len(), 32));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientFrame {
    Hello(HelloFrame),
    Control(ControlFrame),
    Ka(KaFrame),
    Sub(SubFrame),
    Focus(FocusFrame),
}

impl Validate for ClientFrame {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Hello(v) => v.validate(cx),
            Self::Control(v) => v.validate(cx),
            Self::Sub(v) => v.validate(cx),
            Self::Focus(v) => v.validate(cx),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EventFrame {
    pub t: EventLit,
    pub seq: i64,
    pub reason: String,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub payload: Option<Value>,
}

impl Validate for EventFrame {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PatchFrame {
    pub t: PatchLit,
    pub seq: i64,
    pub resource: PatchFrameResource,
    pub op: PatchFrameOp,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub data: Option<Value>,
}

impl Validate for PatchFrame {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PatchFrameResource {
    Workers,
    Pending,
}

impl Validate for PatchFrameResource {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PatchFrameOp {
    Upsert,
    Remove,
}

impl Validate for PatchFrameOp {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveBlock {
    pub worker_id: String,
    pub block_id: String,
    pub channel: LiveBlockChannel,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

impl Validate for LiveBlock {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LiveBlockChannel {
    Reasoning,
    Text,
}

impl Validate for LiveBlockChannel {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFrame {
    pub t: SnapshotLit,
    pub seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<String>,
    pub workers: Vec<Value>,
    pub pending: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<Vec<LiveBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ptys: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub ui_config: Option<Value>,
}

impl Validate for SnapshotFrame {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RowsFrame {
    pub t: RowsLit,
    pub seq: i64,
    pub worker_id: String,
    pub rows: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<Vec<LiveBlock>>,
}

impl Validate for RowsFrame {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssetFrame {
    pub t: AssetLit,
    pub correlation_id: String,
    pub status: i64,
    pub mime: String,
    pub bytes_b64: String,
}

impl Validate for AssetFrame {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum RemoteTier {
    Read,
    Low,
    High,
    Refused,
}

impl Validate for RemoteTier {}

pub const REMOTE_ERROR_CODES: &[&str] =
    &["BAD_VERSION", "AUTH_REJECTED", "CAP_DENIED", "ROUTE_REFUSED", "RATE_LIMITED", "INTERNAL", "FRAME_TOO_LARGE"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteErrorCode {
    BadVersion,
    AuthRejected,
    CapDenied,
    RouteRefused,
    RateLimited,
    Internal,
    FrameTooLarge,
}

impl Validate for RemoteErrorCode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PairingQr {
    pub v: IntLit<3>,
    pub typ: EosPairLit,
    pub relay: String,
    pub room: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer: Option<String>,
    pub exp: i64,
}

impl Validate for PairingQr {
    fn validate(&self, cx: &mut Issues) {
        cx.at("relay", |cx| cx.url(&self.relay));
        cx.at("room", |cx| cx.str_min(&self.room, 43));
        cx.at("bearer", |cx| {
            if let Some(v) = &self.bearer {
                cx.str_min(v, 43);
            }
        });
    }
}
