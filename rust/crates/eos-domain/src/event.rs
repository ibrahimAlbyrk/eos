//! One row of a worker's event log: the chat history.

use eos_contracts::WorkerEventRow;

/// A stored event. `payload` is the JSON text exactly as it was written: the
/// log is replayed to clients as stored, so reading never parses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRecord {
    pub id: i64,
    pub worker_id: String,
    /// Epoch milliseconds.
    pub ts: i64,
    /// A `WorkerEventType` name; kept as text because rows written by older
    /// versions stay readable.
    pub kind: String,
    pub payload: Option<String>,
}

impl EventRecord {
    /// The row as clients read it: the payload stays a JSON string.
    pub fn into_row(self) -> WorkerEventRow {
        WorkerEventRow {
            id: self.id.into(),
            worker_id: self.worker_id,
            ts: self.ts.into(),
            r#type: self.kind,
            payload: self.payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_row_carries_the_payload_as_text() {
        let record = EventRecord {
            id: 7,
            worker_id: "w-1".into(),
            ts: 1_790_000_000_000,
            kind: "state".into(),
            payload: Some(r#"{"state":"IDLE"}"#.into()),
        };
        assert_eq!(
            serde_json::to_string(&record.into_row()).expect("serializes"),
            r#"{"id":7,"worker_id":"w-1","ts":1790000000000,"type":"state","payload":"{\"state\":\"IDLE\"}"}"#
        );
    }
}
