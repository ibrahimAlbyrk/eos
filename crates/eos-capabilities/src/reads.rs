//! What routines read of the capabilities (`CapabilityReads`), and what a
//! signal source's failure does to its capability (`CapabilityHealth`).

use eos_contracts::{CapabilityItem, ItemRef, ResultDoc};
use eos_core::capability::{
    ActionCall, ActionCaller, ActionError, Capability, CapabilityHealth, CapabilityReads, Checkout, ItemRecogniser,
    MissingNeed, PastItemFilter,
};
use eos_core::signals::SourceError;
use eos_core::{BoxFuture, Error};
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::schema::input_error;
use serde_json::{Map, Value};

use crate::health::apply;
use crate::pull::{PULL_REQUEST, Pull, action_input, review_of};
use crate::{CapabilityService, call};

impl CapabilityService {
    /// The kind of item `source` (`github.pulls`) gives.
    async fn item_of(&self, source: &str) -> Result<String, Error> {
        let (capability, name) = source.split_once('.').ok_or_else(|| Error::not_found("source", source))?;
        let loaded = self.load_one(capability).await?.ok_or_else(|| Error::not_found("source", source))?;
        let decl = loaded.capability.manifest.sources.iter().find(|decl| decl.name == name);
        decl.map(|decl| decl.item.clone()).ok_or_else(|| Error::not_found("source", source))
    }

    async fn past(&self, source: &str, filter: &PastItemFilter, limit: usize) -> Result<Vec<CapabilityItem>, Error> {
        let item = self.item_of(source).await?;
        let mut extra: Map<String, Value> =
            filter.scope.iter().map(|(name, value)| (name.clone(), Value::String(value.clone()))).collect();
        extra.insert("state".into(), "all".into());
        self.offered(Some(&item), filter.query.as_deref(), extra, limit).await
    }

    async fn recognised(&self) -> Result<Vec<ItemRecogniser>, Error> {
        let loaded = self.load(None).await?;
        let items = loaded.iter().flat_map(|loaded| loaded.capability.manifest.items.iter());
        Ok(items
            .map(|item| ItemRecogniser {
                kind: item.kind.clone(),
                noun: item.noun.clone(),
                patterns: item.recognise.clone(),
            })
            .collect())
    }

    /// A review result against the input schema of the action that sends it.
    async fn check_result(&self, kind: &str, body: &ResultDoc, item: &ItemRef) -> Result<(), String> {
        if body.kind != kind {
            return Err(format!("the result is a {}, not a {kind}", body.kind));
        }
        let pull = Pull::of_item(item).ok_or_else(|| format!("a {kind} result needs a pull request"))?;
        let commit_id = pull.sha.clone().ok_or_else(|| "the pull request names no commit".to_owned())?;
        let review = review_of(body, &pull, &commit_id)?;
        let loaded = self.load_one(&body.channel).await.map_err(|e| e.to_string())?;
        let loaded = loaded.ok_or_else(|| format!("no capability sends through {}", body.channel))?;
        let action = loaded.capability.manifest.action(&body.action);
        let action = action.ok_or_else(|| format!("{} has no action {}", body.channel, body.action))?;
        let input = action_input(&body.action, &review);
        let issues = action.input.as_ref().map(|schema| call::issues(schema, &input)).unwrap_or_default();
        if issues.is_empty() { Ok(()) } else { Err(input_error(&body.channel, &body.action, &issues)) }
    }

    async fn missing_of(&self, needs: &[String]) -> Result<Vec<MissingNeed>, Error> {
        let loaded = self.load(None).await?;
        let mut missing = Vec::new();
        for need in needs {
            match loaded.iter().find(|loaded| loaded.capability.id == *need) {
                None => missing.push(MissingNeed { id: need.clone(), health: None }),
                Some(loaded) if !loaded.capability.health.state.takes_calls() => {
                    missing.push(MissingNeed { id: need.clone(), health: Some(loaded.capability.health.clone()) });
                }
                Some(_) => {}
            }
        }
        Ok(missing)
    }

    /// A pull request's head, to fetch as `pull/<n>/head`.
    async fn checkout_of(&self, item: &ItemRef) -> Result<Checkout, ActionError> {
        let pull = (item.kind == PULL_REQUEST).then(|| Pull::of_item(item)).flatten().ok_or(ActionError::NotFound)?;
        let call = ActionCall {
            capability: crate::pull::GITHUB.to_owned(),
            action: "get_pull_request".to_owned(),
            input: pull.input(),
            caller: ActionCaller::Candidates,
            idempotency_key: None,
        };
        let read = self.run_call(call).await?.output;
        Ok(Checkout {
            remote: format!("https://github.com/{}.git", pull.repo),
            refspec: format!("pull/{}/head", pull.number),
            sha: read["headSha"].as_str().unwrap_or_default().to_owned(),
        })
    }
}

impl CapabilityReads for CapabilityService {
    fn candidates<'a>(
        &'a self,
        source: &'a str,
        query: Option<&'a str>,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>> {
        Box::pin(async move {
            let item = self.item_of(source).await?;
            CapabilityService::candidates(self, Some(&item), query, limit).await
        })
    }

    fn past_items<'a>(
        &'a self,
        source: &'a str,
        filter: &'a PastItemFilter,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>> {
        Box::pin(self.past(source, filter, limit))
    }

    fn recognisers(&self) -> BoxFuture<'_, Result<Vec<ItemRecogniser>, Error>> {
        Box::pin(self.recognised())
    }

    fn validate_result<'a>(
        &'a self,
        kind: &'a str,
        body: &'a ResultDoc,
        item: &'a ItemRef,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.check_result(kind, body, item))
    }

    fn missing<'a>(&'a self, needs: &'a [String]) -> BoxFuture<'a, Result<Vec<MissingNeed>, Error>> {
        Box::pin(self.missing_of(needs))
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>> {
        eos_core::capability::CapabilityRegistry::list(self)
    }

    fn checkout<'a>(&'a self, item: &'a ItemRef) -> BoxFuture<'a, Result<Checkout, ActionError>> {
        Box::pin(self.checkout_of(item))
    }
}

impl CapabilityHealth for CapabilityService {
    fn report<'a>(&'a self, capability_id: &'a str, error: &'a SourceError) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let event = match error {
                SourceError::Unauthorized => Event::Unauthorized,
                SourceError::Gone => Event::Missing(StateCode::SourceGone),
                _ => return Ok(()),
            };
            let (id, now) = (capability_id.to_owned(), self.ports.clock.now_ms());
            self.ports.store.write(move |tx, outbox| apply(tx, outbox, &id, event, now)).await.map(drop)
        })
    }
}
