//! What the runner routes take and answer: which of the user's computers
//! acts on each routine's triggers, and moving a routine to this one.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

/// `GET /api/runners`: the user's computers as the routine leases show them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunnerView {
    /// This computer's id.
    pub device_id: String,
    pub devices: Vec<RunnerDevice>,
    /// The last time the leases were read; none before the first read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
}

impl Validate for RunnerView {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunnerDevice {
    pub device_id: String,
    pub name: String,
    /// Its last heartbeat.
    pub seen_at: i64,
    /// When its last heartbeat came, once it is over two hours old.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_since: Option<i64>,
    /// The ids of the routines it holds.
    pub routines: Vec<String>,
}

impl Validate for RunnerDevice {}

/// `POST /api/runners/claim`: hold this routine here from now on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    pub routine_id: String,
}

impl Validate for ClaimRequest {}

/// Who holds the routine after the claim: this computer when it won, the
/// computer that claimed it first when it lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub routine_id: String,
    pub claimed: bool,
    pub holder: String,
    pub epoch: i64,
}

impl Validate for ClaimResponse {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_runner_shapes_read_and_write_back_in_camel_case_ignoring_unknown_keys() {
        let view = json!({
            "deviceId": "d-1",
            "devices": [
                {"deviceId": "d-1", "name": "Mac Studio", "seenAt": 9, "routines": ["rt-1"]},
                {"deviceId": "d-2", "name": "MacBook Air", "seenAt": 2, "awaySince": 2, "routines": []},
            ],
            "confirmedAt": 9,
        });
        let mut with_extra = view.clone();
        with_extra["devices"][1]["battery"] = json!(40);
        with_extra["later"] = json!(true);
        let read: RunnerView = crate::parse(&with_extra).unwrap();
        assert_eq!(read.devices[1].away_since, Some(2));
        assert_eq!(serde_json::to_value(&read).unwrap(), view);

        let claim: ClaimRequest = crate::parse(&json!({"routineId": "rt-1", "force": true})).unwrap();
        assert_eq!(claim.routine_id, "rt-1");
        let answer = json!({"routineId": "rt-1", "claimed": false, "holder": "d-2", "epoch": 4});
        let read: ClaimResponse = crate::parse(&answer).unwrap();
        assert_eq!(serde_json::to_value(&read).unwrap(), answer);
    }
}
