use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{IntLit, Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct Fingerprint(pub String);

impl Validate for Fingerprint {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^[0-9a-f]{64}$"), Some("expected a 64-hex certificate fingerprint"));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeerConfig {
    pub enabled: bool,
    pub direct: bool,
    pub port: i64,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertise: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

impl Validate for PeerConfig {
    fn validate(&self, cx: &mut Issues) {
        cx.at("port", |cx| {
            cx.int_min(self.port, 1, true);
            cx.int_max(self.port, 65535, true);
        });
        cx.at("name", |cx| {
            if let Some(v) = &self.name {
                cx.str_min(v, 1);
                cx.str_max(v, 64);
            }
        });
        cx.at("advertise", |cx| {
            if let Some(v) = &self.advertise {
                cx.arr_max(v.len(), 8);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 1);
                        cx.str_max(v, 255);
                    });
                }
            }
        });
        cx.at("relayUrl", |cx| {
            if let Some(v) = &self.relay_url {
                cx.url(v);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertise: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

impl Validate for PeerUpdateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("port", |cx| {
            if let Some(v) = &self.port {
                cx.int_min(*v, 1, true);
                cx.int_max(*v, 65535, true);
            }
        });
        cx.at("name", |cx| {
            if let Some(v) = &self.name {
                cx.str_min(v, 1);
                cx.str_max(v, 64);
            }
        });
        cx.at("advertise", |cx| {
            if let Some(v) = &self.advertise {
                cx.arr_max(v.len(), 8);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 1);
                        cx.str_max(v, 255);
                    });
                }
            }
        });
        cx.at("relayUrl", |cx| {
            if let Some(v) = &self.relay_url {
                cx.url(v);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: Fingerprint,
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub home: String,
    pub api_stamp: String,
    pub serves_ui: bool,
}

impl Validate for HostInfo {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
    }
}

pub const PEER_INVITE_PREFIX: &str = "eos://pair/";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerInvite {
    pub v: IntLit<1>,
    pub fp: Fingerprint,
    pub sec: String,
    pub name: String,
    pub addrs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<PeerInviteRelay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
}

impl Validate for PeerInvite {
    fn validate(&self, cx: &mut Issues) {
        cx.at("fp", |cx| self.fp.validate(cx));
        cx.at("sec", |cx| cx.str_min(&self.sec, 22));
        cx.at("name", |cx| {
            cx.str_min(&self.name, 1);
            cx.str_max(&self.name, 64);
        });
        cx.at("addrs", |cx| {
            cx.arr_max(self.addrs.len(), 12);
            for (i, v) in self.addrs.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 3);
                });
            }
        });
        cx.at("relay", |cx| {
            if let Some(v) = &self.relay {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerInviteRelay {
    pub url: String,
    pub room: String,
}

impl Validate for PeerInviteRelay {
    fn validate(&self, cx: &mut Issues) {
        cx.at("url", |cx| cx.url(&self.url));
        cx.at("room", |cx| cx.str_min(&self.room, 43));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    pub link: String,
    pub device_id: String,
}

impl Validate for InviteResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenInvite {
    pub hash: String,
    pub join_hash: String,
    pub created_at: Num,
}

impl Validate for OpenInvite {
    fn validate(&self, cx: &mut Issues) {
        cx.at("hash", |cx| cx.regex(&self.hash, re!(r"^[0-9a-f]{64}$"), None));
        cx.at("joinHash", |cx| cx.regex(&self.join_hash, re!(r"^[0-9a-f]{64}$"), None));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RelayGrant {
    pub url: String,
    pub room: String,
    pub bearer: String,
}

impl Validate for RelayGrant {
    fn validate(&self, cx: &mut Issues) {
        cx.at("url", |cx| cx.url(&self.url));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PairRequest {
    pub secret: String,
    #[serde(deserialize_with = "de::trimmed")]
    pub name: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal: Option<PairRequestReciprocal>,
}

impl Validate for PairRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("secret", |cx| cx.str_min(&self.secret, 22));
        cx.at("name", |cx| {
            cx.str_min(&self.name, 1);
            cx.str_max(&self.name, 64);
        });
        cx.at("platform", |cx| cx.str_max(&self.platform, 32));
        cx.at("reciprocal", |cx| {
            if let Some(v) = &self.reciprocal {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PairRequestReciprocal {
    pub addrs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayGrant>,
}

impl Validate for PairRequestReciprocal {
    fn validate(&self, cx: &mut Issues) {
        cx.at("addrs", |cx| {
            cx.arr_max(self.addrs.len(), 12);
            for (i, v) in self.addrs.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 3);
                });
            }
        });
        cx.at("relay", |cx| {
            if let Some(v) = &self.relay {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PairResponse {
    pub host: HostInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayGrant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal: Option<bool>,
}

impl Validate for PairResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("host", |cx| self.host.validate(cx));
        cx.at("relay", |cx| {
            if let Some(v) = &self.relay {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub fp: Fingerprint,
    pub name: String,
    pub platform: String,
    pub paired_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub last_seen_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_bearer_hash: Option<String>,
}

impl Validate for PairedDevice {
    fn validate(&self, cx: &mut Issues) {
        cx.at("fp", |cx| self.fp.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceView {
    pub fp: Fingerprint,
    pub name: String,
    pub platform: String,
    pub paired_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub last_seen_at: Option<Num>,
    pub device_id: String,
    pub connected: bool,
}

impl Validate for PairedDeviceView {
    fn validate(&self, cx: &mut Issues) {
        cx.at("fp", |cx| self.fp.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatus {
    pub enabled: bool,
    pub direct: bool,
    pub port: i64,
    pub listening: bool,
    pub host: HostInfo,
    pub addrs: Vec<String>,
    #[serde(deserialize_with = "de::required")]
    pub relay: Option<PeerStatusRelay>,
    pub open_invites: i64,
    pub devices: Vec<PairedDeviceView>,
    /// [`OFF_NETWORK`] when hosting is on but this run of Eos keeps off the
    /// network: nothing listens and no relay is dialled. An addition of the
    /// Rust core, left out otherwise (so a run on the network answers as
    /// today).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off: Option<String>,
}

impl Validate for PeerStatus {
    fn validate(&self, cx: &mut Issues) {
        cx.at("host", |cx| self.host.validate(cx));
        cx.at("devices", |cx| self.devices.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerStatusRelay {
    pub url: String,
    pub online: bool,
}

impl Validate for PeerStatusRelay {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    Connecting,
    Live,
    Reconnecting,
    Offline,
    Unauthorized,
    Incompatible,
}

impl Validate for LinkState {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LinkRoute {
    Direct,
    Relay,
    Reverse,
}

impl Validate for LinkRoute {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub state: LinkState,
    #[serde(deserialize_with = "de::required")]
    pub route: Option<LinkRoute>,
    #[serde(deserialize_with = "de::required")]
    pub rtt_ms: Option<Num>,
    pub since: Num,
    pub attempt: i64,
    #[serde(deserialize_with = "de::required")]
    pub error: Option<String>,
}

impl Validate for LinkStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub id: Fingerprint,
    pub name: String,
    #[serde(deserialize_with = "de::required")]
    pub alias: Option<String>,
    pub platform: String,
    pub addrs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayGrant>,
    pub paired_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub last_connected_at: Option<Num>,
}

impl Validate for KnownHost {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("relay", |cx| {
            if let Some(v) = &self.relay {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: Fingerprint,
    pub name: String,
    #[serde(deserialize_with = "de::required")]
    pub alias: Option<String>,
    pub platform: String,
    pub addrs: Vec<String>,
    pub paired_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub last_connected_at: Option<Num>,
    pub device_id: String,
    pub has_relay: bool,
    pub link: LinkStatus,
    #[serde(deserialize_with = "de::required")]
    pub info: Option<HostInfo>,
}

impl Validate for HostView {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("info", |cx| {
            if let Some(v) = &self.info {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConnectHostRequest {
    pub invite: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mutual: Option<bool>,
}

impl Validate for ConnectHostRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("invite", |cx| cx.str_min(&self.invite, 21));
        cx.at("alias", |cx| {
            if let Some(v) = &self.alias {
                cx.str_max(v, 64);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateHostRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_nullable")]
    pub alias: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addrs: Option<Vec<String>>,
}

impl Validate for UpdateHostRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("alias", |cx| {
            if let Some(Some(v)) = &self.alias {
                cx.str_max(v, 64);
            }
        });
        cx.at("addrs", |cx| {
            if let Some(v) = &self.addrs {
                cx.arr_max(v.len(), 12);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 3);
                    });
                }
            }
        });
    }
}

pub const PEER_DEVICE_HEADER: &str = "x-eos-peer-device";

pub const PEER_HUMAN_HEADER: &str = "x-eos-peer-human";

/// Why a host turned a device away (HTTP/2 GOAWAY opaque data). A device
/// stops retrying on these instead of looping as if the network were down.
pub mod peer_refusal {
    pub const NOT_PAIRED: &str = "not-paired";
    pub const HOSTING_OFF: &str = "remote-access-off";
}

/// Why nothing listens and no host or relay is dialled: only the installed
/// Eos on the user's own data folder reaches other computers.
/// [`PeerStatus::off`], the phone link's `off`, and a link's `error` on such
/// a run.
pub const OFF_NETWORK: &str = "off-network";
