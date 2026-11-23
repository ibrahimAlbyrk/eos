//! What Needs you offers the other areas, answered from what the test sets.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

use eos_core::inbox::{ActionDecision, ActionGate, ActionRequest, AskRoute, AskRouting, ResultEdit, ResultEdits};
use eos_core::store::Tx;
use eos_core::{BoxFuture, Error};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Sends the asks of the workers the test names to Needs you and every
/// other ask to the banner. Records each worker it was asked about.
#[derive(Debug, Default)]
pub struct FakeAskRouting {
    inbox: HashSet<String>,
    asked: Mutex<Vec<String>>,
}

impl FakeAskRouting {
    pub fn new() -> Self {
        Self::default()
    }

    /// `worker_id`'s asks go to Needs you.
    pub fn inbox(mut self, worker_id: &str) -> Self {
        self.inbox.insert(worker_id.to_owned());
        self
    }

    pub fn asked(&self) -> Vec<String> {
        locked(&self.asked).clone()
    }
}

impl AskRouting for FakeAskRouting {
    fn route(&self, _tx: &dyn Tx, worker_id: &str) -> AskRoute {
        locked(&self.asked).push(worker_id.to_owned());
        if self.inbox.contains(worker_id) { AskRoute::Inbox } else { AskRoute::Banner }
    }
}

/// Answers every action with the decision the test set last. Records each
/// request.
#[derive(Debug)]
pub struct FakeActionGate {
    decision: Mutex<ActionDecision>,
    asked: Mutex<Vec<ActionRequest>>,
}

impl FakeActionGate {
    pub fn new(decision: ActionDecision) -> Self {
        Self { decision: Mutex::new(decision), asked: Mutex::default() }
    }

    pub fn set(&self, decision: ActionDecision) {
        *locked(&self.decision) = decision;
    }

    pub fn asked(&self) -> Vec<ActionRequest> {
        locked(&self.asked).clone()
    }
}

impl ActionGate for FakeActionGate {
    fn decide<'a>(&'a self, request: &'a ActionRequest) -> BoxFuture<'a, Result<ActionDecision, Error>> {
        locked(&self.asked).push(request.clone());
        Box::pin(std::future::ready(Ok(locked(&self.decision).clone())))
    }
}

/// The edits the test adds, by their ids. Records each cursor it was read
/// from.
#[derive(Debug, Default)]
pub struct FakeResultEdits {
    edits: Mutex<Vec<ResultEdit>>,
    cursors: Mutex<Vec<i64>>,
}

impl FakeResultEdits {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&self, edit: ResultEdit) {
        locked(&self.edits).push(edit);
    }

    /// The cursors the edits were listed after, in order.
    pub fn cursors(&self) -> Vec<i64> {
        locked(&self.cursors).clone()
    }
}

impl ResultEdits for FakeResultEdits {
    fn list_since(&self, cursor: i64, limit: usize) -> BoxFuture<'_, Result<Vec<ResultEdit>, Error>> {
        locked(&self.cursors).push(cursor);
        let mut after: Vec<ResultEdit> = locked(&self.edits).iter().filter(|edit| edit.id > cursor).cloned().collect();
        after.sort_by_key(|edit| edit.id);
        after.truncate(limit);
        Box::pin(std::future::ready(Ok(after)))
    }

    fn get(&self, edit_id: i64) -> BoxFuture<'_, Result<Option<ResultEdit>, Error>> {
        let edit = locked(&self.edits).iter().find(|edit| edit.id == edit_id).cloned();
        Box::pin(std::future::ready(Ok(edit)))
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::{ActionClass, ResultDoc};

    use super::*;
    use crate::TempStore;

    fn edit(id: i64) -> ResultEdit {
        let doc = ResultDoc { kind: "text".into(), channel: "mail".into(), action: "send".into(), parts: vec![] };
        ResultEdit {
            id,
            item_id: "nd-1".into(),
            delivery_id: None,
            routine_id: "rt-1".into(),
            run_id: "rn-1".into(),
            before: doc.clone(),
            after: doc,
            ops: vec![],
            derived_from_untrusted: false,
            at: id * 10,
        }
    }

    #[test]
    fn asks_of_the_named_workers_go_to_needs_you() {
        let routing = FakeAskRouting::new().inbox("w-run");
        let temp = TempStore::new();
        let routes = temp
            .store
            .read_blocking(move |tx| Ok((routing.route(tx, "w-run"), routing.route(tx, "w-chat"), routing.asked())))
            .expect("reads");
        assert_eq!(routes, (AskRoute::Inbox, AskRoute::Banner, vec!["w-run".to_owned(), "w-chat".to_owned()]));
    }

    #[tokio::test]
    async fn the_gate_answers_as_set_and_keeps_each_request() {
        let gate = FakeActionGate::new(ActionDecision::Run);
        let request = ActionRequest {
            routine_id: "rt-1".into(),
            class: ActionClass::Speak,
            action_id: "github.post_review".into(),
            title: "Post the review".into(),
            args: serde_json::json!({}),
            origin: "surface".into(),
        };
        assert_eq!(gate.decide(&request).await, Ok(ActionDecision::Run));
        gate.set(ActionDecision::Hold { item_id: "nd-1".into() });
        assert_eq!(gate.decide(&request).await, Ok(ActionDecision::Hold { item_id: "nd-1".into() }));
        assert_eq!(gate.asked(), [request.clone(), request]);
    }

    #[tokio::test]
    async fn edits_are_listed_after_a_cursor_in_order_and_found_by_id() {
        let edits = FakeResultEdits::new();
        for id in [3, 1, 2] {
            edits.add(edit(id));
        }
        let ids = |list: Vec<ResultEdit>| list.into_iter().map(|edit| edit.id).collect::<Vec<_>>();
        assert_eq!(ids(edits.list_since(0, 10).await.expect("lists")), [1, 2, 3]);
        assert_eq!(ids(edits.list_since(1, 1).await.expect("lists")), [2]);
        assert_eq!(edits.cursors(), [0, 1]);
        assert_eq!(edits.get(3).await, Ok(Some(edit(3))));
        assert_eq!(edits.get(9).await, Ok(None));
    }
}
