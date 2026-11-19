//! What a sentence typed at Home asks for (01 §4.13): by the rules over the
//! user's routines and the items each recognises, and when those are not
//! sure, by a small model asked once. At most [`MODEL_READS_A_DAY`] model
//! reads a local day on this computer; past them, and when the model fails
//! or is slow, the rules answer. Each model read is booked as `intent`
//! spend. The text is never logged. Which routines take a thing the user
//! dropped is read by the same rules.

use std::time::Duration;

use eos_contracts::{
    IntentAnswer, IntentAttachment, IntentChoice, IntentKind, IntentRequest, ItemRef, MatchItemAnswer, RoutineState,
};
use eos_core::Error;
use eos_core::agent::{OneShotError, OneShotRequest};
use eos_core::capability::ItemRecogniser;
use eos_domain::config::price_for_model;
use eos_domain::cost::cost_usd;
use eos_domain::routine::intent::{self, Asked, CHOICES_MAX, Known, Reading};
use serde_json::{Map, Value, json};

use crate::engine::Engine;
use crate::routes::{BUILTIN, gone, readable, showing_version, today};

/// How many model reads a local day this computer makes.
pub(crate) const MODEL_READS_A_DAY: i64 = 300;
/// Below this the model's reading is a choice, not an answer.
const SURE_ENOUGH: f64 = 0.7;
const MODEL_TIMEOUT_MS: i64 = 4_000;
const SMALL_MODEL: &str = "haiku";
const SPEND_KIND: &str = "intent";

/// A routine the input may name, with what the rules and the model read of it.
pub(crate) struct Listed {
    pub(crate) known: Known,
    pub(crate) summary: String,
    /// The kind of item it takes, and how the run form names one.
    pub(crate) takes_kind: String,
    pub(crate) takes_label: String,
}

/// The patterns that recognise an item of `kind`, leaving out any a
/// JavaScript engine would not compile: the dashboard runs them as they are.
pub(crate) fn item_patterns(recognisers: &[ItemRecogniser], kind: &str) -> Vec<String> {
    let patterns = recognisers.iter().filter(|recogniser| recogniser.kind == kind).flat_map(|r| r.patterns.iter());
    patterns.filter(|pattern| Known::compiles(pattern)).cloned().collect()
}

/// The routines the user has and may run, each with its item patterns.
pub(crate) async fn listed(engine: &Engine) -> Result<Vec<Listed>, Error> {
    let recognisers = match engine.reads.recognisers().await {
        Ok(recognisers) => recognisers,
        Err(error) => {
            tracing::warn!(%error, "the item recognisers could not be read");
            Vec::new()
        }
    };
    let now = engine.clock.now_ms();
    engine
        .store
        .read(move |tx| {
            let mut listed = Vec::new();
            for routine in tx.routines().list()? {
                let hidden =
                    matches!(routine.state, RoutineState::Deleted | RoutineState::Transient | RoutineState::Archived);
                if hidden || routine.origin == BUILTIN || gone(&routine, now) {
                    continue;
                }
                let Some(version) = showing_version(tx, &routine.id)? else { continue };
                let Some(blueprint) = readable(&version)? else { continue };
                let patterns = item_patterns(&recognisers, &blueprint.takes.kind);
                listed.push(Listed {
                    known: Known::new(&routine.id, &routine.name, &routine.slug, &blueprint.aliases, &patterns),
                    summary: blueprint.summary,
                    takes_kind: blueprint.takes.kind,
                    takes_label: blueprint.takes.label,
                });
            }
            Ok(listed)
        })
        .await
}

/// An item as written, as the routine that takes it runs it.
pub(crate) fn item_ref(kind: &str, written: &str) -> ItemRef {
    let (mut url, mut path, mut text) = (None, None, None);
    if written.starts_with("http://") || written.starts_with("https://") {
        url = Some(written.to_owned());
    } else if written.starts_with('/') || written.starts_with('~') {
        path = Some(written.to_owned());
    } else {
        text = Some(written.to_owned());
    }
    ItemRef {
        kind: kind.to_owned(),
        key: None,
        title: None,
        url,
        path,
        text,
        date: None,
        range: None,
        version: None,
        untrusted: false,
    }
}

fn answer(reading: Reading, listed: &[Listed], source: &str, seq: i64) -> IntentAnswer {
    let kind =
        |id: &str| listed.iter().find(|routine| routine.known.id == id).map(|routine| routine.takes_kind.as_str());
    let item = match (&reading.routine_id, &reading.item) {
        (Some(id), Some(written)) => kind(id).map(|kind| item_ref(kind, written)),
        _ => None,
    };
    IntentAnswer {
        intent: reading.intent,
        certain: reading.certain,
        line: reading.line,
        routine_id: reading.routine_id,
        item,
        options: Map::new(),
        alternatives: reading.alternatives,
        source: source.to_owned(),
        seq,
    }
}

fn rules_reading(asked: &IntentRequest, listed: &[Listed]) -> Reading {
    let attachments: Vec<String> = asked.attachments.iter().map(|attachment| attachment.value.clone()).collect();
    let known: Vec<Known> = listed.iter().map(|routine| routine.known.clone()).collect();
    let asked = Asked {
        text: &asked.text,
        attachments: &attachments,
        forced: asked.forced,
        routine_id: asked.routine_id.as_deref(),
    };
    intent::read(&asked, &known)
}

/// `POST /api/routines/intent`: the rules' reading.
pub(crate) async fn by_rules(engine: &Engine, asked: &IntentRequest) -> Result<IntentAnswer, Error> {
    let listed = listed(engine).await?;
    Ok(answer(rules_reading(asked, &listed), &listed, "rules", asked.seq))
}

/// `POST /api/routines/match-item`: a run of each routine that takes the
/// thing (its kind is the routine's, or the routine recognises its value),
/// then doing it once.
pub(crate) async fn match_item(engine: &Engine, item: &IntentAttachment) -> Result<MatchItemAnswer, Error> {
    let listed = listed(engine).await?;
    let takers =
        listed.iter().filter(|routine| routine.takes_kind == item.kind || routine.known.item_in(&item.value).is_some());
    let mut choices: Vec<IntentChoice> =
        takers.map(|routine| intent::choice(IntentKind::Run, Some(&routine.known), Some(&item.value))).collect();
    choices.push(intent::choice(IntentKind::Once, None, None));
    Ok(MatchItemAnswer { choices })
}

/// `POST /api/routines/intent/model`: the small model's reading; the rules'
/// when the day's reads are used up or the model gives none in time.
pub(crate) async fn by_model(engine: &Engine, asked: &IntentRequest) -> Result<IntentAnswer, Error> {
    let listed = listed(engine).await?;
    let rules = rules_reading(asked, &listed);
    if !take_read(engine).await? {
        tracing::info!("the day's intent reads are used up: the rules answer");
        return Ok(answer(rules, &listed, "rules", asked.seq));
    }
    let request = request(engine, asked, &listed)?;
    let started = engine.clock.now_ms();
    let asked_model = engine.one_shot.complete(request);
    let replied = tokio::time::timeout(Duration::from_millis(MODEL_TIMEOUT_MS as u64), asked_model).await;
    let replied = match replied {
        Ok(replied) => replied,
        Err(_) => Err(OneShotError::TimedOut(Duration::from_millis(MODEL_TIMEOUT_MS as u64))),
    };
    let ms = engine.clock.now_ms() - started;
    let (cost, model_reading) = match replied {
        Ok(replied) => {
            let config = engine.config.current();
            let price = price_for_model(&config, Some(replied.model.as_deref().unwrap_or(SMALL_MODEL)));
            let cost = replied.usage.as_ref().map_or(0.0, |usage| cost_usd(price, usage));
            (cost, replied.structured.as_ref().and_then(|data| model_reading(data, &listed, &rules)))
        }
        Err(error) => {
            tracing::warn!(%error, ms, "the intent model gave no answer: the rules answer");
            (0.0, None)
        }
    };
    let routine_id = model_reading
        .as_ref()
        .and_then(|reading| reading.routine_id.clone())
        .or_else(|| asked.routine_id.clone())
        .unwrap_or_default();
    book(engine, &routine_id, cost).await?;
    Ok(match model_reading {
        Some(reading) => {
            tracing::info!(intent = ?reading.intent, certain = reading.certain, ms, "the intent model answered");
            answer(reading, &listed, "model", asked.seq)
        }
        None => answer(rules, &listed, "rules", asked.seq),
    })
}

/// Counts one model read against today's, unless they are used up.
async fn take_read(engine: &Engine) -> Result<bool, Error> {
    let day = today(engine);
    let stored_day = day.clone();
    let stored: i64 = engine
        .store
        .read(move |tx| {
            let spend = tx.routine_spend().of_day(&stored_day)?;
            Ok(spend.iter().filter(|row| row.kind == SPEND_KIND).map(|row| row.count).sum())
        })
        .await?;
    let mut reads = engine.intent_reads.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let counted = reads.as_ref().filter(|(at, _)| *at == day).map_or(0, |(_, n)| *n);
    let n = counted.max(stored);
    if n >= MODEL_READS_A_DAY {
        return Ok(false);
    }
    *reads = Some((day, n + 1));
    Ok(true)
}

/// Books one model read on today's `intent` spend; an empty routine id for
/// a read that named no routine.
async fn book(engine: &Engine, routine_id: &str, cost: f64) -> Result<(), Error> {
    let (day, routine_id) = (today(engine), routine_id.to_owned());
    engine.store.write(move |tx, _| tx.routine_spend().add(&day, &routine_id, SPEND_KIND, cost)).await
}

fn request(engine: &Engine, asked: &IntentRequest, listed: &[Listed]) -> Result<OneShotRequest, Error> {
    let routines: Vec<String> = listed
        .iter()
        .map(|routine| {
            let known = &routine.known;
            format!(
                "- id: {} | name: {} | aliases: {} | does: {} | takes: {} ({})",
                known.id,
                known.name,
                known.aliases.join(", "),
                routine.summary,
                routine.takes_label,
                routine.takes_kind
            )
        })
        .collect();
    let mut text = asked.text.clone();
    for attachment in &asked.attachments {
        text.push_str(&format!("\n[{}] {}", attachment.kind, attachment.value));
    }
    let values = [("TEXT", text), ("ROUTINES", routines.join("\n"))]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), Value::String(value)))
        .collect();
    let none = eos_prompts::service::no_values();
    let prompt = engine.prompts.render("routine/intent", &values, &none)?;
    let system = engine.prompts.render("routine/intent-system", &none, &none)?;
    Ok(OneShotRequest::new(prompt)
        .model(Some(SMALL_MODEL))
        .system(system)
        .schema(schema())
        .timeout_ms(MODEL_TIMEOUT_MS))
}

fn schema() -> Value {
    let intent = json!({ "type": "string", "enum": ["run", "make", "once", "change"] });
    json!({
        "type": "object",
        "properties": {
            "intent": intent,
            "routineId": { "type": "string" },
            "item": { "type": "string" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "line": { "type": "string" },
            "choices": {
                "type": "array",
                "maxItems": CHOICES_MAX,
                "items": {
                    "type": "object",
                    "properties": { "intent": intent, "routineId": { "type": "string" }, "line": { "type": "string" } },
                    "required": ["intent", "line"],
                },
            },
        },
        "required": ["intent", "confidence", "line"],
    })
}

/// A reading of the model's answer, or `None` when it is not one: an intent
/// this app does not know, or a run or change of a routine the user lacks.
fn model_reading(data: &Value, listed: &[Listed], rules: &Reading) -> Option<Reading> {
    let known = |id: &str| listed.iter().any(|routine| routine.known.id == id);
    let choice = |value: &Value| -> Option<IntentChoice> {
        let intent: IntentKind = serde_json::from_value(value["intent"].clone()).ok()?;
        let routine_id = value["routineId"].as_str().filter(|id| known(id)).map(str::to_owned);
        let needs_routine = matches!(intent, IntentKind::Run | IntentKind::Change);
        if intent == IntentKind::Unsure || needs_routine != routine_id.is_some() {
            return None;
        }
        Some(IntentChoice { intent, line: value["line"].as_str()?.to_owned(), routine_id })
    };
    let chosen = choice(data)?;
    let confidence = data["confidence"].as_f64()?;
    if confidence < SURE_ENOUGH {
        let mut choices: Vec<IntentChoice> =
            data["choices"].as_array().into_iter().flatten().filter_map(choice).take(CHOICES_MAX).collect();
        if choices.is_empty() {
            choices = rules.alternatives.clone();
        }
        return Some(Reading {
            intent: IntentKind::Unsure,
            certain: false,
            line: intent::UNSURE_LINE.to_owned(),
            routine_id: None,
            item: None,
            alternatives: choices,
        });
    }
    let item = data["item"].as_str().filter(|item| !item.trim().is_empty() && chosen.intent == IntentKind::Run);
    Some(Reading {
        intent: chosen.intent,
        certain: true,
        line: chosen.line,
        routine_id: chosen.routine_id,
        item: item.map(str::to_owned),
        alternatives: rules.alternatives.iter().filter(|choice| choice.intent != chosen.intent).cloned().collect(),
    })
}
