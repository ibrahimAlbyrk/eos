//! The channels a routine's results go out through, in memory.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::BoxFuture;
use eos_core::delivery::{
    Channel, ChannelTraits, Channels, Fresh, Receipt, SendError, SendRequest, Target, UndoOutcome,
};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The channels the test adds, each with the same traits for every action.
/// Every send and undo is recorded. A send answers what the test scripted
/// for it, in order, and otherwise succeeds with receipt `rc-<n>` (`n`
/// counting sends from 1); a lookup finds what a successful send with that
/// key left, or what the test says one left. Results are fresh unless the
/// test makes the next ones stale, and an undo answers what the test
/// scripted for undos, else succeeds.
#[derive(Debug, Default, Clone)]
pub struct FakeChannels(Arc<Shared>);

#[derive(Debug, Default)]
struct Shared {
    traits: Mutex<HashMap<String, ChannelTraits>>,
    outcomes: Mutex<VecDeque<Result<Receipt, SendError>>>,
    sent: Mutex<Vec<SendRequest>>,
    receipts: Mutex<HashMap<String, Receipt>>,
    undone: Mutex<Vec<Receipt>>,
    stale: Mutex<VecDeque<String>>,
    undos: Mutex<VecDeque<UndoOutcome>>,
}

impl FakeChannels {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `channel`, with `traits` for each of its actions.
    pub fn with(self, channel: &str, traits: ChannelTraits) -> Self {
        locked(&self.0.traits).insert(channel.to_owned(), traits);
        self
    }

    /// What the next send not scripted yet answers.
    pub fn script(&self, outcome: Result<Receipt, SendError>) {
        locked(&self.0.outcomes).push_back(outcome);
    }

    /// What a send with `key` left at the service, though its answer was lost.
    pub fn left(&self, key: &str, receipt: Receipt) {
        locked(&self.0.receipts).insert(key.to_owned(), receipt);
    }

    /// The next precondition not scripted yet finds the result stale.
    pub fn stale(&self, reason: &str) {
        locked(&self.0.stale).push_back(reason.to_owned());
    }

    /// What the next undo not scripted yet answers.
    pub fn undoes(&self, outcome: UndoOutcome) {
        locked(&self.0.undos).push_back(outcome);
    }

    /// Every send asked of any channel, in order, whatever it answered.
    pub fn sent(&self) -> Vec<SendRequest> {
        locked(&self.0.sent).clone()
    }

    /// Every receipt asked to be undone, in order.
    pub fn undone(&self) -> Vec<Receipt> {
        locked(&self.0.undone).clone()
    }
}

impl Channels for FakeChannels {
    fn get(&self, channel: &str) -> Option<Arc<dyn Channel>> {
        let known = locked(&self.0.traits).contains_key(channel);
        known.then(|| Arc::new(FakeChannel { name: channel.to_owned(), shared: self.0.clone() }) as Arc<dyn Channel>)
    }
}

struct FakeChannel {
    name: String,
    shared: Arc<Shared>,
}

impl Channel for FakeChannel {
    fn traits(&self, _action: &str) -> Option<ChannelTraits> {
        locked(&self.shared.traits).get(&self.name).copied()
    }

    fn precondition<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        let fresh = match locked(&self.shared.stale).pop_front() {
            Some(reason) => Fresh::Stale { reason },
            None => Fresh::Fresh,
        };
        Box::pin(std::future::ready(Ok(fresh)))
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        let count = {
            let mut sent = locked(&self.shared.sent);
            sent.push(req.clone());
            sent.len()
        };
        let outcome = locked(&self.shared.outcomes)
            .pop_front()
            .unwrap_or_else(|| Ok(Receipt { id: format!("rc-{count}"), url: None }));
        if let Ok(receipt) = &outcome {
            locked(&self.shared.receipts).insert(req.key.clone(), receipt.clone());
        }
        Box::pin(std::future::ready(outcome))
    }

    fn lookup<'a>(&'a self, key: &'a str, _target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        Box::pin(std::future::ready(Ok(locked(&self.shared.receipts).get(key).cloned())))
    }

    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        locked(&self.shared.undone).push(receipt.clone());
        let outcome = locked(&self.shared.undos).pop_front().unwrap_or(UndoOutcome::Undone);
        Box::pin(std::future::ready(Ok(outcome)))
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::{ActionClass, ResultDoc};
    use eos_core::delivery::{Idempotency, Place, SendErrorKind, Undo};

    use super::*;

    fn request(key: &str) -> SendRequest {
        SendRequest {
            key: key.into(),
            channel: "github".into(),
            action: "post_review".into(),
            target: Target { recipient_id: "pr".into(), place: Place::Item("github:pr:acme/game#482".into()) },
            body: ResultDoc {
                kind: "github.review".into(),
                channel: "github".into(),
                action: "post_review".into(),
                parts: vec![],
            },
        }
    }

    #[tokio::test]
    async fn sends_are_recorded_and_answer_as_scripted_then_succeed() {
        let traits = ChannelTraits {
            class: ActionClass::Speak,
            idempotency: Idempotency::Marker,
            undo: Undo::Partial,
            undo_window_ms: 0,
            max_bytes: 65_536,
        };
        let channels = FakeChannels::new().with("github", traits);
        assert!(channels.get("mail").is_none(), "a channel the test did not add");
        let github = channels.get("github").expect("added");
        assert_eq!(github.traits("approve_pull_request"), Some(traits));
        let busy = SendError { kind: SendErrorKind::Transient, detail_kind: "rate_limited".into() };
        channels.script(Err(busy.clone()));

        let (first, second) = (request("dl-1"), request("dl-2"));
        assert_eq!(github.send(&first).await, Err(busy));
        let receipt = github.send(&second).await.expect("sent");
        assert_eq!(receipt, Receipt { id: "rc-2".into(), url: None });
        assert_eq!(channels.sent(), [first.clone(), second.clone()]);
        assert_eq!(github.lookup("dl-1", &first.target).await, Ok(None), "the failed send left nothing");
        assert_eq!(github.lookup("dl-2", &second.target).await, Ok(Some(receipt.clone())));
        assert_eq!(github.precondition(&second).await, Ok(Fresh::Fresh));
        assert_eq!(github.undo(&receipt).await, Ok(UndoOutcome::Undone));
        assert_eq!(channels.undone(), [receipt]);
    }
}
