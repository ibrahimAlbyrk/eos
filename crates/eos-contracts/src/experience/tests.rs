use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::*;

/// Reads `value` with one key it does not know added, and writes it back
/// without that key, in the same order.
fn round_trip<T: DeserializeOwned + Serialize + Validate>(value: Value) -> T {
    let mut with_extra = value.clone();
    with_extra.as_object_mut().unwrap().insert("later".into(), json!({"x": 1}));
    let read: T = crate::parse(&with_extra).unwrap();
    assert_eq!(serde_json::to_string(&read).unwrap(), serde_json::to_string(&value).unwrap());
    read
}

#[test]
fn the_topics_read_and_write_their_fields_in_order() {
    round_trip::<ExperienceChange>(json!({"ids": ["mn-0a1b2c3d4e5f"], "action": "learned"}));
    round_trip::<ExperienceRecalledEvent>(
        json!({"workerId": "w-1", "runId": "rn-1", "noteIds": ["mn-0a1b2c3d4e5f"], "how": "pack"}),
    );
    round_trip::<ExperienceRecalledEvent>(json!({"workerId": "w-1", "noteIds": [], "how": "reminder"}));
}

#[test]
fn the_settings_read_and_write_both_switches() {
    let read = round_trip::<ExperienceSettings>(json!({"learning": false, "reminders": true}));
    assert_eq!(read, ExperienceSettings { learning: false, reminders: true });
}
