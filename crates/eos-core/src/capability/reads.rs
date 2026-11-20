//! What the capabilities tell routines: items to pick and past ones, how an
//! item is known in what the user types, whether a result fits the action
//! that sends it, what a routine still lacks, and where a pull request's
//! code is; and how a signal source reports a capability broken.

use eos_contracts::{CapabilityItem, ItemRef, ResultDoc};
use eos_domain::capability::health::Health;
use eos_domain::result_doc::shape::ResultShape;

use super::{ActionError, Capability};
use crate::signals::{Scope, SourceError};
use crate::{BoxFuture, Error};

/// A kind of item and how it is known in text, from a capability's
/// `[[items]]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRecogniser {
    /// `github.pull_request`.
    pub kind: String,
    /// `pull request`.
    pub noun: String,
    /// JavaScript-compatible regular expressions over links and numbers.
    pub patterns: Vec<String>,
}

/// Which items of a source were seen before.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PastItemFilter {
    /// Where the source reads (`{"repo": "acme/game"}`).
    pub scope: Scope,
    /// Words that narrow them, as the capability reads them.
    pub query: Option<String>,
}

/// Where a run fetches an item's code: a pull request's head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    /// The repository's clone URL.
    pub remote: String,
    /// `pull/<n>/head`.
    pub refspec: String,
    /// The head commit.
    pub sha: String,
}

/// A capability a routine needs that does not work here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingNeed {
    pub id: String,
    /// Where it stands; `None` when it is not on this computer.
    pub health: Option<Health>,
}

/// What routines read of the capabilities.
pub trait CapabilityReads: Send + Sync {
    /// Items of the kind `source` gives, for the user to pick, newest first.
    fn candidates<'a>(
        &'a self,
        source: &'a str,
        query: Option<&'a str>,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>>;
    /// Items of `source` in `filter.scope`, those done with included,
    /// newest first.
    fn past_items<'a>(
        &'a self,
        source: &'a str,
        filter: &'a PastItemFilter,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<CapabilityItem>, Error>>;
    fn recognisers(&self) -> BoxFuture<'_, Result<Vec<ItemRecogniser>, Error>>;
    /// The shape of a `kind` result, as the channel here that sends it
    /// declares it; `None` when none does.
    fn result_shape(&self, kind: &str) -> Option<ResultShape>;
    /// Whether `body`, a result of `kind` about `item`, has the kind's shape
    /// and fits the input of the channel action that sends it; else what
    /// does not, one line each.
    fn validate_result<'a>(
        &'a self,
        kind: &'a str,
        body: &'a ResultDoc,
        item: &'a ItemRef,
    ) -> BoxFuture<'a, Result<(), Vec<String>>>;
    /// Of the capabilities `needs` names, those that are not here or do not
    /// take calls.
    fn missing<'a>(&'a self, needs: &'a [String]) -> BoxFuture<'a, Result<Vec<MissingNeed>, Error>>;
    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>>;
    /// Where the code of `item` is fetched from.
    fn checkout<'a>(&'a self, item: &'a ItemRef) -> BoxFuture<'a, Result<Checkout, ActionError>>;
}

/// What a signal source's failure tells of its capability.
pub trait CapabilityHealth: Send + Sync {
    /// `Unauthorized` moves the capability to `needs_sign_in`, `Gone` to
    /// `needs_setup`; other failures change nothing.
    fn report<'a>(&'a self, capability_id: &'a str, error: &'a SourceError) -> BoxFuture<'a, Result<(), Error>>;
}
