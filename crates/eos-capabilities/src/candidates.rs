//! The items capabilities offer the user to pick (a pull request, a mail):
//! each `[[candidates]]` action is called with `{q?, limit}` and answers
//! `{items: CapabilityItem[]}`; for a source's past items it is also given
//! the source's scope and `state: "all"`. A capability that cannot answer is
//! left out.

use eos_contracts::CapabilityItem;
use eos_core::Error;
use eos_core::capability::{ActionCall, ActionCaller};
use serde_json::{Map, Value};

use crate::CapabilityService;

/// The most items one answer lists.
pub const CANDIDATES_MAX: usize = 100;

/// The items of an answer; `None` when it has another shape.
fn items_of(mut output: Value) -> Option<Vec<CapabilityItem>> {
    serde_json::from_value(output.get_mut("items")?.take()).ok()
}

impl CapabilityService {
    /// Items of kind `item` (every kind when none), newest first, at most
    /// `limit`; `q` narrows them as each capability reads it.
    pub async fn candidates(
        &self,
        item: Option<&str>,
        q: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CapabilityItem>, Error> {
        self.offered(item, q, Map::new(), limit).await
    }

    /// [`candidates`](Self::candidates), each action also given `extra`
    /// (a past item's scope and state).
    pub(crate) async fn offered(
        &self,
        item: Option<&str>,
        q: Option<&str>,
        extra: Map<String, Value>,
        limit: usize,
    ) -> Result<Vec<CapabilityItem>, Error> {
        let limit = limit.min(CANDIDATES_MAX);
        let mut input = extra;
        if let Some(q) = q {
            input.insert("q".into(), q.into());
        }
        input.insert("limit".into(), limit.into());
        let mut items = Vec::new();
        for loaded in self.load(None).await? {
            let capability = &loaded.capability;
            let offered = capability.manifest.candidates.iter().filter(|c| item.is_none_or(|item| c.item == item));
            for offer in offered {
                let call = ActionCall {
                    capability: capability.id.clone(),
                    action: offer.action.clone(),
                    input: Value::Object(input.clone()),
                    caller: ActionCaller::Candidates,
                    idempotency_key: None,
                };
                match self.run_call(call).await.map(|result| items_of(result.output)) {
                    Ok(Some(found)) => items.extend(found),
                    Ok(None) => {
                        tracing::warn!(capability = %capability.id, "a capability's candidates have another shape")
                    }
                    Err(e) => {
                        tracing::info!(capability = %capability.id, error_kind = e.kind(), "no candidates from a capability")
                    }
                }
            }
        }
        items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
        items.truncate(limit);
        Ok(items)
    }
}
