//! The channels deliveries go out through (03's contract), over the
//! built-ins' actions. `github` sends a review result as one review that
//! ends with the delivery's marker, so a send repeated after a crash finds
//! the first; it is taken back by withdrawing the review.

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller, ActionError, FailureKind};
use eos_core::delivery::{
    Channel, ChannelTraits, Channels, Fresh, Idempotency, Place, Receipt, SendError, SendErrorKind, SendRequest,
    Target, Undo, UndoOutcome,
};
use serde_json::{Value, json};

use crate::CapabilityService;
use crate::pull::{GITHUB, Pull, action_input, review_of};

/// The largest review body GitHub takes.
const REVIEW_MAX_BYTES: usize = 65_536;
/// How long after a send a review's comments can be taken back.
const REVIEW_UNDO_MS: i64 = 24 * 60 * 60 * 1000;

/// Every channel of the built-ins, by name.
pub(crate) struct BuiltinChannels(pub(crate) Arc<CapabilityService>);

impl Channels for BuiltinChannels {
    fn get(&self, channel: &str) -> Option<Arc<dyn Channel>> {
        (channel == GITHUB && self.0.builtins.contains_key(GITHUB))
            .then(|| Arc::new(GitHubChannel(self.0.clone())) as Arc<dyn Channel>)
    }
}

fn failure(kind: SendErrorKind, detail_kind: &str) -> SendError {
    SendError { kind, detail_kind: detail_kind.to_owned() }
}

/// How a failed call reads to delivery. `sending`: the call would have put
/// something out, so a lost answer leaves it unknown whether it did.
pub(crate) fn send_error(error: &ActionError, sending: bool) -> SendError {
    use SendErrorKind::{Auth, NotFound, Permanent, Transient, Uncertain, UserDraftInProgress};
    match error {
        ActionError::Failed { kind: FailureKind::UserDraftInProgress } => {
            failure(UserDraftInProgress, "user_draft_in_progress")
        }
        // GitHub: approving or asking for changes on one's own pull request.
        ActionError::Failed { kind: FailureKind::NotAllowed } => failure(Permanent, "own_pull_request"),
        ActionError::Failed { kind: FailureKind::Validation } | ActionError::Invalid(_) => {
            failure(Permanent, "validation")
        }
        ActionError::Failed { kind: FailureKind::Unauthorized } | ActionError::NotReady(_) => {
            failure(Auth, error.kind())
        }
        ActionError::Failed { kind: FailureKind::Gone } => failure(NotFound, "gone"),
        ActionError::Timeout | ActionError::Failed { kind: FailureKind::Output } if sending => {
            failure(Uncertain, error.kind())
        }
        ActionError::NotFound | ActionError::NotGranted => failure(Permanent, error.kind()),
        _ => failure(Transient, error.kind()),
    }
}

struct GitHubChannel(Arc<CapabilityService>);

/// The pull request a delivery's target names.
fn pull_of(target: &Target) -> Result<Pull, SendError> {
    match &target.place {
        Place::Item(key) => Pull::from_key(key).ok_or_else(|| failure(SendErrorKind::Permanent, "target")),
        Place::Me | Place::Address(_) => Err(failure(SendErrorKind::Permanent, "target")),
    }
}

impl GitHubChannel {
    async fn call(&self, action: &str, input: Value, key: Option<&str>) -> Result<Value, ActionError> {
        let call = ActionCall {
            capability: GITHUB.to_owned(),
            action: action.to_owned(),
            input,
            caller: ActionCaller::Delivery { run_id: String::new(), delivery_id: key.unwrap_or_default().to_owned() },
            idempotency_key: key.map(str::to_owned),
        };
        Ok(self.0.run_call(call).await?.output)
    }

    /// The pull request's head commit now.
    async fn head(&self, pull: &Pull, key: &str) -> Result<String, SendError> {
        let read = self.call("get_pull_request", pull.input(), Some(key)).await;
        let read = read.map_err(|e| send_error(&e, false))?;
        Ok(read["headSha"].as_str().unwrap_or_default().to_owned())
    }

    async fn fresh(&self, req: &SendRequest) -> Result<Fresh, SendError> {
        let pull = pull_of(&req.target)?;
        let Some(drafted) = &pull.sha else { return Ok(Fresh::Fresh) };
        if self.head(&pull, &req.key).await? == *drafted {
            Ok(Fresh::Fresh)
        } else {
            Ok(Fresh::Stale { reason: "new commits".to_owned() })
        }
    }

    async fn deliver(&self, req: &SendRequest) -> Result<Receipt, SendError> {
        if self.traits(&req.action).is_none() || req.body.action != req.action {
            return Err(failure(SendErrorKind::Permanent, "action"));
        }
        let pull = pull_of(&req.target)?;
        let commit_id = match &pull.sha {
            Some(sha) => sha.clone(),
            None => self.head(&pull, &req.key).await?,
        };
        let review = review_of(&req.body, &pull, &commit_id).map_err(|_| failure(SendErrorKind::Permanent, "body"))?;
        if review.body.len() > REVIEW_MAX_BYTES {
            return Err(failure(SendErrorKind::Permanent, "too_long"));
        }
        let sent = self.call(&req.action, action_input(&req.action, &review), Some(&req.key)).await;
        let sent = sent.map_err(|e| send_error(&e, true))?;
        let id = sent["reviewId"].as_u64().map(|id| id.to_string()).unwrap_or_default();
        let url = sent["url"].as_str().filter(|url| !url.is_empty()).map(str::to_owned);
        tracing::info!(capability = GITHUB, action = %req.action, delivery_id = %req.key, "a review went out");
        Ok(Receipt { id, url })
    }

    async fn find(&self, key: &str, target: &Target) -> Result<Option<Receipt>, SendError> {
        let pull = pull_of(target)?;
        let mut input = pull.input();
        input["key"] = json!(key);
        let found = self.call("find_review", input, Some(key)).await.map_err(|e| send_error(&e, false))?;
        // A pending review is not out yet: sending again submits it.
        if found["found"] != true || found["state"] == "PENDING" {
            return Ok(None);
        }
        let id = found["reviewId"].as_u64().map(|id| id.to_string()).unwrap_or_default();
        Ok(Some(Receipt { id, url: found["url"].as_str().map(str::to_owned) }))
    }

    async fn withdraw(&self, receipt: &Receipt) -> Result<UndoOutcome, SendError> {
        let pull = receipt.url.as_deref().and_then(Pull::from_url);
        let pull = pull.ok_or_else(|| failure(SendErrorKind::Permanent, "receipt"))?;
        let review_id: u64 = receipt.id.parse().map_err(|_| failure(SendErrorKind::Permanent, "receipt"))?;
        let mut input = pull.input();
        input["reviewId"] = json!(review_id);
        let undone = self.call("withdraw_review", input, None).await.map_err(|e| send_error(&e, false))?;
        Ok(if undone["deleted"] == true { UndoOutcome::Undone } else { UndoOutcome::Partial })
    }
}

impl Channel for GitHubChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        match action {
            "post_review" => Some(ChannelTraits {
                class: ActionClass::Speak,
                idempotency: Idempotency::Marker,
                undo: Undo::Partial,
                undo_window_ms: REVIEW_UNDO_MS,
                max_bytes: REVIEW_MAX_BYTES,
            }),
            "approve_pull_request" => Some(ChannelTraits {
                class: ActionClass::Irreversible,
                idempotency: Idempotency::Marker,
                undo: Undo::None,
                undo_window_ms: 0,
                max_bytes: REVIEW_MAX_BYTES,
            }),
            _ => None,
        }
    }

    fn precondition<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        Box::pin(self.fresh(req))
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        Box::pin(self.deliver(req))
    }

    fn lookup<'a>(&'a self, key: &'a str, target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        Box::pin(self.find(key, target))
    }

    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        Box::pin(self.withdraw(receipt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_failure_reads_to_delivery_as_what_it_means() {
        let kind = |error: ActionError, sending| send_error(&error, sending);
        let failed = |kind| ActionError::Failed { kind };
        let read = |error: SendError| (error.kind, error.detail_kind);
        use SendErrorKind::*;
        assert_eq!(
            read(kind(failed(FailureKind::UserDraftInProgress), true)),
            (UserDraftInProgress, "user_draft_in_progress".into())
        );
        assert_eq!(read(kind(failed(FailureKind::NotAllowed), true)), (Permanent, "own_pull_request".into()));
        assert_eq!(read(kind(failed(FailureKind::Validation), true)), (Permanent, "validation".into()));
        assert_eq!(read(kind(failed(FailureKind::Unauthorized), true)), (Auth, "unauthorized".into()));
        assert_eq!(read(kind(ActionError::NotReady("http_401".into()), true)).0, Auth);
        assert_eq!(read(kind(failed(FailureKind::Service), true)), (Transient, "service".into()));
        assert_eq!(read(kind(ActionError::RateLimited { retry_after_s: 60 }, true)).0, Transient);
        assert_eq!(read(kind(ActionError::Timeout, true)), (Uncertain, "timeout".into()), "the answer was lost");
        assert_eq!(read(kind(ActionError::Timeout, false)).0, Transient, "a read that timed out sent nothing");
        assert_eq!(read(kind(failed(FailureKind::Gone), false)), (NotFound, "gone".into()));
    }
}
