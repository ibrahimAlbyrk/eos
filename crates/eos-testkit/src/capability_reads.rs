//! What routines read of the capabilities, and what sources report of
//! them, answered from what the test sets and recorded.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use eos_contracts::{CapabilityItem, ItemRef, ResultDoc};
use eos_core::capability::{
    ActionError, Capability, CapabilityHealth, CapabilityReads, Checkout, ItemRecogniser, MissingNeed, PastItemFilter,
};
use eos_core::signals::SourceError;
use eos_core::{BoxFuture, Error};
use eos_domain::result_doc::shape::ResultShape;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Items, recognisers, shapes, gaps and checkouts as the test gives them. A
/// result passes unless its kind was set to fail or it misses the shape set
/// for its kind; an item without a checkout is not found.
#[derive(Debug, Default)]
pub struct FakeCapabilityReads {
    items: HashMap<String, Vec<CapabilityItem>>,
    recognisers: Vec<ItemRecogniser>,
    refused: HashMap<String, String>,
    shapes: HashMap<String, ResultShape>,
    missing: Vec<MissingNeed>,
    capabilities: Vec<Capability>,
    checkouts: HashMap<String, Checkout>,
    asked: Mutex<Vec<String>>,
}

impl FakeCapabilityReads {
    pub fn new() -> Self {
        Self::default()
    }

    /// The items of `source`, for candidates and past items alike.
    pub fn items(mut self, source: &str, items: Vec<CapabilityItem>) -> Self {
        self.items.insert(source.to_owned(), items);
        self
    }

    pub fn recognising(mut self, recogniser: ItemRecogniser) -> Self {
        self.recognisers.push(recogniser);
        self
    }

    /// Results of `kind` fail with `text`.
    pub fn refusing(mut self, kind: &str, text: &str) -> Self {
        self.refused.insert(kind.to_owned(), text.to_owned());
        self
    }

    /// Results of the shape's kind are told and held to it.
    pub fn shaping(mut self, shape: ResultShape) -> Self {
        self.shapes.insert(shape.kind.clone(), shape);
        self
    }

    pub fn lacking(mut self, need: MissingNeed) -> Self {
        self.missing.push(need);
        self
    }

    pub fn listing(mut self, capability: Capability) -> Self {
        self.capabilities.push(capability);
        self
    }

    /// The checkout of the item whose key is `key`.
    pub fn checkout_of(mut self, key: &str, checkout: Checkout) -> Self {
        self.checkouts.insert(key.to_owned(), checkout);
        self
    }

    /// What it was asked, in order: `candidates <source>`, `past <source>`,
    /// `validate <kind>`, `checkout <key>`.
    pub fn asked(&self) -> Vec<String> {
        locked(&self.asked).clone()
    }

    fn ask(&self, what: String) {
        locked(&self.asked).push(what);
    }

    fn of(&self, source: &str, limit: usize) -> Vec<CapabilityItem> {
        self.items.get(source).map(|items| items.iter().take(limit).cloned().collect()).unwrap_or_default()
    }
}

impl CapabilityReads for FakeCapabilityReads {
    fn candidates<'a>(
        &'a self,
        source: &'a str,
        _query: Option<&'a str>,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>> {
        self.ask(format!("candidates {source}"));
        Box::pin(std::future::ready(Ok(self.of(source, limit))))
    }

    fn past_items<'a>(
        &'a self,
        source: &'a str,
        _filter: &'a PastItemFilter,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>> {
        self.ask(format!("past {source}"));
        Box::pin(std::future::ready(Ok(self.of(source, limit))))
    }

    fn recognisers(&self) -> BoxFuture<'_, Result<Vec<ItemRecogniser>, Error>> {
        Box::pin(std::future::ready(Ok(self.recognisers.clone())))
    }

    fn result_shape(&self, kind: &str) -> Option<ResultShape> {
        self.shapes.get(kind).cloned()
    }

    fn validate_result<'a>(
        &'a self,
        kind: &'a str,
        body: &'a ResultDoc,
        _item: &'a ItemRef,
    ) -> BoxFuture<'a, Result<(), Vec<String>>> {
        self.ask(format!("validate {kind}"));
        let misfits = match (self.refused.get(kind), self.shapes.get(kind)) {
            (Some(text), _) => vec![text.clone()],
            (None, Some(shape)) => shape.check(body),
            (None, None) => Vec::new(),
        };
        Box::pin(std::future::ready(if misfits.is_empty() { Ok(()) } else { Err(misfits) }))
    }

    fn missing<'a>(&'a self, needs: &'a [String]) -> BoxFuture<'a, Result<Vec<MissingNeed>, Error>> {
        let missing = self.missing.iter().filter(|need| needs.contains(&need.id)).cloned().collect();
        Box::pin(std::future::ready(Ok(missing)))
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>> {
        Box::pin(std::future::ready(Ok(self.capabilities.clone())))
    }

    fn checkout<'a>(&'a self, item: &'a ItemRef) -> BoxFuture<'a, Result<Checkout, ActionError>> {
        let key = item.key.clone().unwrap_or_default();
        self.ask(format!("checkout {key}"));
        Box::pin(std::future::ready(self.checkouts.get(&key).cloned().ok_or(ActionError::NotFound)))
    }
}

/// Records every failure a source reported, by capability.
#[derive(Debug, Default)]
pub struct FakeCapabilityHealth {
    reports: Mutex<Vec<(String, SourceError)>>,
}

impl FakeCapabilityHealth {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reports(&self) -> Vec<(String, SourceError)> {
        locked(&self.reports).clone()
    }
}

impl CapabilityHealth for FakeCapabilityHealth {
    fn report<'a>(&'a self, capability_id: &'a str, error: &'a SourceError) -> BoxFuture<'a, Result<(), Error>> {
        locked(&self.reports).push((capability_id.to_owned(), error.clone()));
        Box::pin(std::future::ready(Ok(())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_answer_what_the_test_set_and_record_what_was_asked() {
        let checkout = Checkout {
            remote: "https://github.com/acme/game.git".into(),
            refspec: "pull/7/head".into(),
            sha: "abc".into(),
        };
        let reads = FakeCapabilityReads::new()
            .refusing("github.review", "no event")
            .checkout_of("github:pr:acme/game#7", checkout.clone());
        let item = ItemRef {
            kind: "github.pull_request".into(),
            key: Some("github:pr:acme/game#7".into()),
            title: None,
            url: None,
            path: None,
            text: None,
            date: None,
            range: None,
            version: None,
            untrusted: true,
        };
        let doc = ResultDoc {
            kind: "github.review".into(),
            channel: "github".into(),
            action: "post_review".into(),
            parts: Vec::new(),
        };
        assert_eq!(reads.validate_result("github.review", &doc, &item).await, Err(vec!["no event".to_owned()]));
        assert_eq!(reads.checkout(&item).await, Ok(checkout));
        assert!(reads.candidates("github.pulls", None, 10).await.expect("items").is_empty());
        assert_eq!(
            reads.asked(),
            ["validate github.review", "checkout github:pr:acme/game#7", "candidates github.pulls"]
        );

        let health = FakeCapabilityHealth::new();
        health.report("github", &SourceError::Gone).await.expect("reports");
        assert_eq!(health.reports(), [("github".to_owned(), SourceError::Gone)]);
    }
}
