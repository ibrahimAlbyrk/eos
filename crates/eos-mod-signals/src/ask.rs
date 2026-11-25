//! The model's stage of Which (02 §3 D.19, H.42): a signal whose rules
//! passed for a routine that asks a question waits `undecided` (reason
//! [`ASK`]) until the small model answers `{"matches": boolean}` about it.
//!
//! After each routing pass the stage takes those decisions of routines
//! that still ask, the ones waiting for the model before the ones past the
//! day's asks, first decided first, [`ASKS_AT_ONCE`] at a time. The
//! question and the source's text facts, cut to [`FACTS_TEXT_MAX`]
//! characters and inside the untrusted block, go to the model off the
//! writer thread; its answer is one write: the run admitted as the router admits, or `unmatched` (reason [`ASK`]), with
//! the call's spend booked as `match`. An answer is kept for the same
//! routine version and subject for [`ASK_CACHE_MS`], in memory. Past
//! [`ASKS_PER_DAY`] asks of a routine in the user's day (reason [`CAP`]),
//! without a credential, or when the model gives no answer, the decision
//! stays undecided and is tried again on a later pass; after
//! [`UNSORTED_AFTER_MS`] it is `unsorted`. Outside the installed app the
//! model is never asked (the router decides those [`DEV_RUN`]), and nothing
//! is asked while Eos is stopped. Questions and facts are never logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

use eos_contracts::{Fact, Facts};
use eos_core::Error;
use eos_core::agent::{OneShot, OneShotError, OneShotRequest};
use eos_core::routine::RoutineTriggers;
use eos_core::store::{ConfigSource, StoredSignalRoute};
use eos_domain::config::price_for_model;
use eos_domain::cost::cost_usd;
use eos_domain::routine::limits::day_key;
use eos_domain::signals::decision::Decision;
use eos_domain::untrusted::wrap;
use eos_prompts::PromptService;
use eos_prompts::templates::micro_task::signal_match;
use serde_json::json;

use crate::router::{Router, error_kind, halted_in};
use crate::summary::day_start;

/// Waiting for the model, or unmatched by it.
pub(crate) const ASK: &str = "ask";
/// Waiting past the routine's asks for the day.
pub(crate) const CAP: &str = "cap";
/// Outside the installed app: the model is never asked.
pub(crate) const DEV_RUN: &str = "dev-run";

pub const ASK_TIMEOUT_MS: i64 = 20_000;
pub const ASKS_AT_ONCE: usize = 2;
pub const ASKS_PER_DAY: i64 = 200;
pub const ASK_CACHE_MS: i64 = 7 * 24 * 60 * 60_000;
pub const UNSORTED_AFTER_MS: i64 = 24 * 60 * 60_000;
pub const FACTS_TEXT_MAX: usize = 2_000;
/// The model asked: a small one.
const MODEL: &str = "haiku";
/// What the spend of an ask is booked as.
const SPEND_KIND: &str = "match";
/// The decisions one pass takes at most.
const PASS_MAX: i64 = 100;

/// What the stage asks through, and what it remembers.
pub(crate) struct Asks {
    pub(crate) one_shot: Arc<dyn OneShot>,
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) config: Arc<dyn ConfigSource>,
    /// The model's answer by routine version and subject, with when it came.
    cache: Mutex<HashMap<(String, String), (bool, i64)>>,
    /// The asks of each routine under way and not written yet, so two at
    /// once do not pass its asks for the day together.
    asking: Mutex<HashMap<String, i64>>,
    /// Rings after a routing pass: there may be decisions for the model.
    pub(crate) kick: Notify,
}

impl Asks {
    pub(crate) fn new(one_shot: Arc<dyn OneShot>, prompts: Arc<PromptService>, config: Arc<dyn ConfigSource>) -> Self {
        Self { one_shot, prompts, config, cache: Mutex::default(), asking: Mutex::default(), kick: Notify::new() }
    }

    fn cache(&self) -> MutexGuard<'_, HashMap<(String, String), (bool, i64)>> {
        self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn asking(&self) -> MutexGuard<'_, HashMap<String, i64>> {
        self.asking.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One ask of `routine_id` under way, unless with the ones already
    /// under way it would pass the day's asks.
    fn reserve(&self, routine_id: &str, asked: i64) -> Option<Asking<'_>> {
        let mut asking = self.asking();
        let under_way = asking.entry(routine_id.to_owned()).or_default();
        if asked + *under_way >= ASKS_PER_DAY {
            return None;
        }
        *under_way += 1;
        Some(Asking { asks: self, routine_id: routine_id.to_owned() })
    }
}

/// An ask under way, counted until its answer is written or dropped.
struct Asking<'a> {
    asks: &'a Asks,
    routine_id: String,
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        let mut asking = self.asks.asking();
        if let Some(under_way) = asking.get_mut(&self.routine_id) {
            *under_way -= 1;
            if *under_way <= 0 {
                asking.remove(&self.routine_id);
            }
        }
    }
}

/// The source's text facts as lines, cut to [`FACTS_TEXT_MAX`] characters.
pub(crate) fn facts_text(facts: &Facts) -> String {
    let lines = facts.iter().filter_map(|(name, fact)| match fact {
        Fact::Text(text) => Some(format!("{name}: {text}")),
        Fact::List(items) => Some(format!("{name}: {}", items.join(", "))),
        Fact::Bool(_) | Fact::Number(_) => None,
    });
    lines.collect::<Vec<_>>().join("\n").chars().take(FACTS_TEXT_MAX).collect()
}

/// What became of one waiting decision.
enum Settled {
    /// The model's answer, or the cache's.
    Answered { matches: bool, asked: bool, cost: f64 },
    /// Past the routine's asks for the day.
    Capped,
    /// Waited too long.
    Unsorted,
    /// Tried again later.
    Later,
}

impl Router {
    /// Takes the decisions that wait for the model, [`ASKS_AT_ONCE`] at a
    /// time; one that cannot be written is left for a later pass.
    pub(crate) async fn ask_pass(&self) -> Result<(), Error> {
        if !self.autostart || self.store.read(halted_in).await? {
            return Ok(());
        }
        let routines = self.directory.triggers().await?;
        // A routine past its asks for the day, or one that no longer asks,
        // must not keep the others' decisions from the model.
        let asking: Vec<String> =
            routines.iter().filter(|routine| routine.which.ask.is_some()).map(|routine| routine.id.clone()).collect();
        if asking.is_empty() {
            return Ok(());
        }
        let waiting = self
            .store
            .read(move |tx| {
                let asking: Vec<&str> = asking.iter().map(String::as_str).collect();
                tx.signal_asks().waiting_asks(&asking, &[ASK, CAP], PASS_MAX)
            })
            .await?;
        for pair in waiting.chunks(ASKS_AT_ONCE) {
            let one = |route: &StoredSignalRoute| self.ask_one(route.clone(), &routines);
            match pair {
                [first, second] => {
                    let _ = tokio::join!(one(first), one(second));
                }
                [first] => one(first).await,
                _ => {}
            }
        }
        Ok(())
    }

    async fn ask_one(&self, route: StoredSignalRoute, routines: &[RoutineTriggers]) {
        let (signal_id, routine_id) = (route.signal_id, route.routine_id.clone());
        if let Err(error) = self.settle(route, routines).await {
            tracing::warn!(signal_id, %routine_id, error = error_kind(&error), "a question could not be settled");
        }
    }

    /// Settles one decision that waits for the model.
    async fn settle(&self, route: StoredSignalRoute, routines: &[RoutineTriggers]) -> Result<(), Error> {
        let Some(routine) = routines.iter().find(|routine| routine.id == route.routine_id).cloned() else {
            return Ok(());
        };
        let Some(question) = routine.which.ask.clone() else { return Ok(()) };
        let id = route.signal_id;
        let Some(signal) = self.store.read(move |tx| tx.signals().find(id)).await? else { return Ok(()) };
        let now = self.clock.now_ms();
        let key = (routine.version.clone(), signal.signal.subject.clone());
        let cached = self.asks.cache().get(&key).filter(|(_, at)| now - at < ASK_CACHE_MS).map(|(matches, _)| *matches);
        let mut reserved = None;
        let settled = if let Some(matches) = cached {
            Settled::Answered { matches, asked: false, cost: 0.0 }
        } else if now - route.decided_at >= UNSORTED_AFTER_MS {
            Settled::Unsorted
        } else {
            let (routine_id, today) = (routine.id.clone(), day_start(self.zone.as_ref(), now));
            let asked = self.store.read(move |tx| tx.signal_asks().asked_since(&routine_id, today)).await?;
            reserved = self.asks.reserve(&routine.id, asked);
            if reserved.is_none() {
                Settled::Capped
            } else {
                let facts: Facts =
                    signal.signal.facts_json.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default();
                let item = wrap(&signal.signal.subject, &facts_text(&facts));
                self.ask_model(&question, &item).await?
            }
        };
        if let Settled::Answered { matches, asked: true, .. } = settled {
            let mut cache = self.asks.cache();
            // Answers past their time are dropped, so the cache does not grow for good.
            cache.retain(|_, (_, at)| now - *at < ASK_CACHE_MS);
            cache.insert(key, (matches, now));
        }
        let written = self.write_settled(route, routine, settled).await;
        drop(reserved);
        written
    }

    /// One call of the model; its answer and what it cost.
    async fn ask_model(&self, question: &str, item: &str) -> Result<Settled, Error> {
        let prompt = signal_match(&self.asks.prompts, question, item)?;
        let request = OneShotRequest::new(prompt)
            .model(Some(MODEL))
            .schema(json!({
                "type": "object",
                "properties": { "matches": { "type": "boolean" } },
                "required": ["matches"],
                "additionalProperties": false,
            }))
            .timeout_ms(ASK_TIMEOUT_MS);
        let answer = match self.asks.one_shot.complete(request).await {
            Ok(answer) => answer,
            Err(OneShotError::NoCredential) => {
                tracing::info!("no credential to ask the model: the signal waits");
                return Ok(Settled::Later);
            }
            Err(error) => {
                let kind = if matches!(error, OneShotError::TimedOut(_)) { "timed_out" } else { "failed" };
                tracing::warn!(kind, "the model gave no answer: the signal waits");
                return Ok(Settled::Later);
            }
        };
        let config = self.asks.config.current();
        let price = price_for_model(&config, Some(answer.model.as_deref().unwrap_or(MODEL)));
        let cost = answer.usage.as_ref().map_or(0.0, |usage| cost_usd(price, usage));
        Ok(match answer.structured.as_ref().and_then(|data| data["matches"].as_bool()) {
            Some(matches) => Settled::Answered { matches, asked: true, cost },
            None => {
                tracing::warn!("the model's answer had no verdict: the signal waits");
                Settled::Later
            }
        })
    }

    /// Writes what became of the decision, in one job, if it still waits.
    async fn write_settled(
        &self,
        route: StoredSignalRoute,
        routine: RoutineTriggers,
        settled: Settled,
    ) -> Result<(), Error> {
        if matches!(settled, Settled::Later) {
            return Ok(());
        }
        let routing = self.routing();
        let day = day_key(routing.now, self.zone.offset_minutes_at(routing.now));
        self.store
            .write(move |tx, out| {
                let id = route.signal_id;
                let still =
                    tx.signal_routes().by_signal(id)?.into_iter().find(|row| row.routine_id == route.routine_id);
                let waiting = still.is_some_and(|row| {
                    row.decision == Decision::Undecided && matches!(row.reason.as_deref(), Some(ASK | CAP))
                });
                // The model was asked: its call is spent, whether or not its answer is used.
                if let Settled::Answered { asked: true, cost, .. } = settled {
                    tx.routine_spend().add(&day, &routine.id, SPEND_KIND, cost)?;
                }
                if !waiting || halted_in(tx)? {
                    return Ok(());
                }
                let Some(signal) = tx.signals().find(id)? else { return Ok(()) };
                let (decided, model_asked) = match settled {
                    Settled::Answered { matches, asked, .. } => {
                        let decided = if matches {
                            routing.admit_in(tx, out, &routine, &signal)?
                        } else {
                            (Decision::Unmatched, Some(ASK.to_owned()), None)
                        };
                        (decided, asked)
                    }
                    Settled::Capped => {
                        // It keeps the time it was first decided, for when it turns unsorted.
                        let capped = StoredSignalRoute { reason: Some(CAP.into()), ..route };
                        return tx.signal_routes().put(&capped);
                    }
                    Settled::Unsorted => ((Decision::Unsorted, Some(ASK.to_owned()), None), false),
                    Settled::Later => return Ok(()),
                };
                let (decision, reason, run_id) = decided;
                let kept = StoredSignalRoute {
                    routine_version: routine.version.clone(),
                    decision,
                    reason,
                    run_id,
                    model_asked,
                    decided_at: routing.now,
                    ..route
                };
                routing.keep_in(tx, out, &routine, &signal, kept, false)
            })
            .await
    }
}
