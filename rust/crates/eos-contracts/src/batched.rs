//! Answers of routes carried inside one answer: the boot snapshot (`GET /api/boot`) and
//! the batched stat (`POST /fs/stat`). Both are additions of the Rust core, not routes of
//! `contracts/src/http.ts`: every route they gather still answers on its own, and each
//! carried answer is what that route answers, byte for byte.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::validate::{Issues, Validate};

/// One route's answer: its status and its JSON body as it was written.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RouteAnswer {
    pub status: u16,
    #[schemars(with = "serde_json::Value")]
    pub body: Box<RawValue>,
}

impl Validate for RouteAnswer {}

/// What the dashboard's first paint needs, in the order it asks for it. The keys of
/// [`BootSnapshot::parts`] are these targets, written as the dashboard writes them.
pub const BOOT_PARTS: [&str; 10] = [
    "/workers?brief=1",
    "/api/ui-config",
    "/api/settings",
    "/api/settings/compaction",
    "/pending",
    "/fs/recents",
    "/projects",
    "/api/profile",
    "/api/accounts",
    "/api/plugins",
];

/// The newest page of the chat on screen, as its transcript asks for it.
pub fn boot_page_target(worker_id: &str) -> String {
    format!("/workers/{worker_id}/events?since=0&order=desc&limit=500")
}

/// `GET /api/boot[?focus=<worker id>]`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BootSnapshot {
    /// The data of the `hello` a stream opened before the parts were read would have got
    /// (`{epoch, seq, caps}`). A stream opened with `since=<epoch>-<seq>` replays every
    /// change the parts may not show.
    #[schemars(with = "serde_json::Value")]
    pub hello: Box<RawValue>,
    /// By target ([`BOOT_PARTS`], then the focused chat's page). A part whose answer is not
    /// JSON, or is too large to carry, is left out: the dashboard asks its route itself.
    pub parts: IndexMap<String, RouteAnswer>,
}

impl Validate for BootSnapshot {}

/// How many paths one `POST /fs/stat` may name.
pub const FS_STAT_BATCH_MAX: usize = 200;

/// `POST /fs/stat`: several paths, each answered as `GET /fs/stat?path=` answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStatBatchRequest {
    pub paths: Vec<String>,
}

impl Validate for FsStatBatchRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("paths", |cx| cx.arr_max(self.paths.len(), FS_STAT_BATCH_MAX));
    }
}

/// One answer per path, in the order the request named them.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FsStatBatchResponse {
    pub results: Vec<RouteAnswer>,
}

impl Validate for FsStatBatchResponse {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_carried_answer_keeps_its_body_as_written() {
        let text = r#"{"hello":{"epoch":"e","seq":3,"caps":[]},"parts":{"/pending":{"status":200,"body":[ 1,2 ]}}}"#;
        let snapshot: BootSnapshot = serde_json::from_str(text).expect("parses");
        assert_eq!(snapshot.parts["/pending"].body.get(), "[ 1,2 ]");
        assert_eq!(serde_json::to_string(&snapshot).expect("writes"), text);
    }

    #[test]
    fn a_batch_names_at_most_the_bound() {
        let paths = vec!["/a".to_owned(); FS_STAT_BATCH_MAX + 1];
        assert!(crate::validate::check(&FsStatBatchRequest { paths }).is_err());
        assert!(crate::validate::check(&FsStatBatchRequest { paths: vec![] }).is_ok());
    }

    #[test]
    fn the_page_target_is_the_transcripts_own() {
        assert_eq!(boot_page_target("w-1"), "/workers/w-1/events?since=0&order=desc&limit=500");
    }
}
