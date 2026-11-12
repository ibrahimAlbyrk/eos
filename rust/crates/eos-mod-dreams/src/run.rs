//! One dream (`core/src/use-cases/DreamOverChats.ts`). Durability is
//! counted, not guessed:
//!
//! - recall: one request per chat → signals (what the user asked for, how
//!   they said it);
//! - filter: code drops signals about the product, one task, or an accepted option;
//! - match: one request files the rest into the candidate ledger, which
//!   outlives the night; watermarks move once the ledger holds tonight's signals;
//! - consolidate: one request, only when a candidate is ready — at most a
//!   few proposals, written as rules that open with their situation;
//! - critic: one request in its own context tries to refute each proposal;
//! - file: the survivors go to the suggestion sink (duplicates, declined
//!   ideas, the cap).
//!
//! Most nights end before consolidate: nothing new is ready, and that is a
//! good night.

use std::collections::HashSet;
use std::sync::Arc;

use eos_contracts::{
    AgentEvent, AgentMessageEventRole, ContentBlock, DreamCandidate, DreamChatRead, DreamConsolidateOutput,
    DreamCriticOutput, DreamEvidence, DreamEvidenceBy, DreamMatchOutput, DreamProgress, DreamRecallOutput,
    DreamRejected, DreamRun, DreamRunStatus, DreamSetAsideWhy, DreamTrigger, UserMemory, UserMemoryId,
    UserMemoryProposal, UserMemorySource, UserMemorySourceDream, parse,
};
use eos_core::agent::{OneShot, OneShotRequest};
use eos_core::os::TimeZone;
use eos_core::profile::{UserMemoryReader, UserMemorySuggestion, UserMemorySuggestionSink, UserProfileReader};
use eos_core::prompt::ProfileRenderer;
use eos_core::store::{ConfigSource, EventOrder, EventQuery, Store};
use eos_core::{Clock, Error, Ids};
use eos_prompts::PromptService;
use eos_prompts::templates::dream::{Step, step};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ledger::{NightSignal, apply_matches, decay_ledger, grounded_marker, is_candidate_ready, summarize_support};
use crate::prompt_data::{format_candidates, format_memories, format_proposals, format_signals};
use crate::rules::{
    ChatFilter, CheckedProposal, DREAM_CHAT_CHARS, DreamLine, DreamSession, apply_verdicts, check_proposals, clip,
    empty_dropped, filter_signals, looks_secret, pick_chats, render_chat_for_dream,
};

const QUOTE_CHARS: usize = 300;
const FILED_EVIDENCE_MAX: usize = 8;
const REJECTED_MAX: usize = 12;
/// A chat's newest rows a dream loads: a long chat keeps its latest turns.
const ROWS_PER_CHAT: i64 = 3000;
/// Rough characters per token, for the run's own estimate of what it spent.
const CHARS_PER_TOKEN: f64 = 3.5;

/// What a dream reads and runs on.
#[derive(Clone)]
pub struct DreamParts {
    pub store: Arc<dyn Store>,
    pub one_shot: Arc<dyn OneShot>,
    pub prompts: Arc<PromptService>,
    pub memories: Arc<dyn UserMemoryReader>,
    pub suggestions: Arc<dyn UserMemorySuggestionSink>,
    pub profile: Arc<dyn UserProfileReader>,
    /// What agents are already told about the user.
    pub profile_text: Arc<dyn ProfileRenderer>,
    pub config: Arc<dyn ConfigSource>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub zone: Arc<dyn TimeZone>,
}

impl std::fmt::Debug for DreamParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DreamParts").finish_non_exhaustive()
    }
}

/// The JSON Schema of one of the four structured answers, with nothing left to look up.
fn schema_of<T: JsonSchema>() -> Value {
    let settings = schemars::generate::SchemaSettings::default().with(|s| s.inline_subschemas = true);
    let mut schema = serde_json::to_value(settings.into_generator().into_root_schema_for::<T>()).unwrap_or(Value::Null);
    if let Some(object) = schema.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
    }
    schema
}

/// The top-level chats, each with its newest row.
async fn sessions(store: &dyn Store) -> Result<Vec<DreamSession>, Error> {
    store
        .read(|tx| {
            let mut sessions = Vec::new();
            for worker in tx.workers().list_all()?.into_iter().filter(|w| w.parent_id.is_none()) {
                let newest = EventQuery {
                    worker_id: worker.id.clone(),
                    since: 0,
                    limit: 1,
                    order: EventOrder::Desc,
                    before_id: None,
                    after_id: None,
                };
                sessions.push(DreamSession {
                    last_event_id: tx.events().list(&newest)?.first().map_or(0, |row| row.id),
                    name: worker.name.clone().unwrap_or_else(|| worker.id.clone()),
                    project: worker.cwd.clone().or(worker.worktree_from.clone()),
                    no_folder: worker.scratch,
                    working: worker.state == eos_contracts::WorkerState::Working,
                    worker_id: worker.id,
                });
            }
            Ok(sessions)
        })
        .await
}

/// What the user and the agent said in a row, if it is a message of theirs.
fn line_of(kind: &str, payload: Option<&str>) -> Option<(bool, String)> {
    let said = |text: &str| !text.trim().is_empty();
    let payload: Value = serde_json::from_str(payload?).ok()?;
    match kind {
        "user_message" => payload["text"].as_str().filter(|t| said(t)).map(|t| (true, t.to_owned())),
        "jsonl" if payload["kind"] == "assistant_text" => {
            payload["text"].as_str().filter(|t| said(t)).map(|t| (false, t.to_owned()))
        }
        "agent_event" => {
            let AgentEvent::Message(message) = serde_json::from_value(payload).ok()? else { return None };
            if message.role != AgentMessageEventRole::Assistant {
                return None;
            }
            let texts: Vec<&str> = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text(text) if said(&text.text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect();
            Some((false, texts.join("\n"))).filter(|(_, text)| said(text))
        }
        _ => None,
    }
}

/// A chat's messages after row `after`, oldest first.
async fn lines(store: &dyn Store, worker_id: &str, after: i64) -> Result<Vec<DreamLine>, Error> {
    let query = EventQuery {
        worker_id: worker_id.to_owned(),
        since: 0,
        limit: ROWS_PER_CHAT,
        order: EventOrder::Desc,
        before_id: None,
        after_id: None,
    };
    let rows = store.read(move |tx| tx.events().list(&query)).await?;
    let newer = rows.into_iter().rev().filter(|row| row.id > after);
    Ok(newer
        .filter_map(|row| {
            let (by_user, text) = line_of(&row.kind, row.payload.as_deref())?;
            Some(DreamLine { id: row.id, by_user, text, at: row.ts })
        })
        .collect())
}

/// The newest lines behind a candidate, one per event.
fn evidence_of(candidate: &DreamCandidate) -> Vec<DreamEvidence> {
    let mut seen = HashSet::new();
    let all = candidate.support.iter().flat_map(|s| &s.evidence).rev();
    all.filter(|e| seen.insert(e.event_id)).take(FILED_EVIDENCE_MAX).cloned().collect()
}

/// A dream in progress: what it has read and spent so far.
struct Dream<'a> {
    parts: &'a DreamParts,
    run: DreamRun,
    model: String,
    timeout_ms: i64,
    tokens: i64,
}

impl Dream<'_> {
    async fn save(&self) -> Result<(), Error> {
        let run = self.run.clone();
        self.parts.store.write(move |tx, _| tx.dreams().save(&run)).await
    }

    async fn finish(mut self, status: DreamRunStatus, reason: Option<String>) -> Result<DreamRun, Error> {
        self.run.status = status;
        self.run.reason = reason;
        self.run.tokens = self.tokens;
        self.run.finished_at = Some(self.parts.clock.now_ms().into());
        self.save().await?;
        Ok(self.run)
    }

    async fn fail(self, what: &str, why: Option<String>) -> Result<DreamRun, Error> {
        let why = why.map_or_else(|| " — the answer didn't fit its schema".to_owned(), |why| format!(": {why}"));
        self.finish(DreamRunStatus::Failed, Some(format!("Couldn't {what}{why}"))).await
    }

    /// One structured request. `Ok(None)`: the answer did not fit its type.
    async fn ask<T: DeserializeOwned + eos_contracts::Validate + JsonSchema>(
        &mut self,
        which: Step,
        vars: &[(&str, &str)],
    ) -> Result<Option<T>, String> {
        let (system, prompt) = step(&self.parts.prompts, which, vars).map_err(|e| e.to_string())?;
        let spent = system.encode_utf16().count() + prompt.encode_utf16().count();
        let request = OneShotRequest::new(prompt)
            .system(system)
            .model(Some(&self.model))
            .schema(schema_of::<T>())
            .timeout_ms(self.timeout_ms);
        let answer = self.parts.one_shot.complete(request).await.map_err(|e| e.to_string())?;
        let data = answer.structured.ok_or_else(|| "the model returned no structured output".to_owned())?;
        let size = spent + data.to_string().encode_utf16().count();
        self.tokens += (size as f64 / CHARS_PER_TOKEN).ceil() as i64;
        Ok(parse::<T>(&data).ok())
    }
}

/// Runs one dream to its end and returns its record, which is also saved.
/// `should_stop` is asked before each chat; `on_progress` hears each step.
pub async fn dream_over_chats(
    parts: &DreamParts,
    trigger: DreamTrigger,
    should_stop: &(dyn Fn() -> bool + Send + Sync),
    on_progress: &(dyn Fn(DreamProgress) + Send + Sync),
) -> Result<DreamRun, Error> {
    let settings = parts.profile.get().dreaming.clone();
    let model =
        serde_json::to_value(settings.model).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    let (excluded, sessions) =
        (parts.store.read(|tx| tx.dreams().excluded()).await?, sessions(parts.store.as_ref()).await?);
    let ids: Vec<String> = sessions.iter().map(|s| s.worker_id.clone()).collect();
    let watermarks = parts
        .store
        .read(move |tx| {
            ids.into_iter().map(|id| Ok((tx.dreams().watermark(&id)?, id))).collect::<Result<Vec<_>, Error>>()
        })
        .await?;
    let filter = ChatFilter {
        max_chats: usize::try_from(settings.max_chats).unwrap_or(0),
        excluded_projects: settings.excluded_projects.clone(),
        include_no_folder: settings.include_no_folder,
        excluded_chats: excluded.into_iter().collect(),
        watermarks: watermarks.into_iter().map(|(mark, id)| (id, mark)).collect(),
    };
    let chats = pick_chats(sessions, &filter);
    let now = parts.clock.now_ms();
    let zone = parts.zone.clone();
    let offset_at = move |at: i64| zone.offset_minutes_at(at);
    let run = DreamRun {
        id: parts.ids.dream_run_id(),
        trigger,
        status: DreamRunStatus::Running,
        reason: None,
        started_at: now.into(),
        finished_at: None,
        model: model.clone(),
        chats_read: 0,
        observations: 0,
        proposed: 0,
        tokens: 0,
        narrative: None,
        dropped: empty_dropped(),
        chats: Vec::new(),
        candidates: 0,
        rejected: Vec::new(),
    };
    let timeout_ms = parts.config.current().compaction.timeout_ms;
    let mut dream = Dream { parts, run, model, timeout_ms, tokens: 0 };
    if chats.is_empty() {
        return dream.finish(DreamRunStatus::Skipped, Some("Nothing new since the last dream".into())).await;
    }
    dream.save().await?;

    // ---- recall + filter ----
    let mut night: Vec<NightSignal> = Vec::new();
    let mut read_chats: Vec<&DreamSession> = Vec::new();
    let mut stopped = false;
    let progress = |done: usize, chat: Option<&str>, night: &[NightSignal]| {
        on_progress(DreamProgress {
            done: done as i64,
            total: chats.len() as i64,
            chat: chat.map(str::to_owned),
            noticed: night.iter().rev().take(3).rev().map(|n| n.signal.ask.clone()).collect(),
        });
    };
    for (i, chat) in chats.iter().enumerate() {
        if should_stop() {
            stopped = true;
            break;
        }
        progress(i, Some(&chat.name), &night);
        let mark = filter.watermarks.get(&chat.worker_id).copied().unwrap_or(0);
        let rendered =
            render_chat_for_dream(&lines(parts.store.as_ref(), &chat.worker_id, mark).await?, DREAM_CHAT_CHARS);
        let mut read = DreamChatRead {
            worker_id: chat.worker_id.clone(),
            name: chat.name.clone(),
            project: chat.project.clone(),
            user_turns: rendered.user_turns,
            observations: 0,
        };
        if rendered.user_turns > 0 {
            let vars = [
                ("CHAT", chat.name.as_str()),
                ("PROJECT", chat.project.as_deref().unwrap_or("no folder")),
                ("TRANSCRIPT", rendered.text.as_str()),
            ];
            // A chat whose request failed stays unread: its watermark does not move, the next dream tries again.
            let Ok(answer) = dream.ask::<DreamRecallOutput>(Step::Recall, &vars).await else { continue };
            let signals: Vec<_> =
                answer.map(|a| a.signals).unwrap_or_default().into_iter().filter(|s| !looks_secret(&s.ask)).collect();
            read.observations = signals.len() as i64;
            dream.run.observations += read.observations;
            let kept = filter_signals(signals);
            dream.run.dropped.product += kept.product;
            dream.run.dropped.task_bound += kept.task_bound;
            dream.run.dropped.choice += kept.choice;
            for mut signal in kept.kept {
                // Evidence must be the user's own lines.
                let cited: Vec<&DreamLine> =
                    signal.evidence.iter().filter_map(|id| rendered.lines.get(id)).filter(|l| l.by_user).collect();
                let Some(at) = cited.iter().map(|l| l.at).min() else {
                    dream.run.dropped.invalid += 1;
                    continue;
                };
                let said: Vec<&str> = cited.iter().map(|l| l.text.as_str()).collect();
                signal.marker = grounded_marker(signal.marker.as_deref(), &said);
                let evidence = cited
                    .iter()
                    .map(|l| DreamEvidence {
                        quote: clip(&l.text, QUOTE_CHARS),
                        worker_id: chat.worker_id.clone(),
                        chat: chat.name.clone(),
                        event_id: Some(l.id),
                        by: DreamEvidenceBy::User,
                    })
                    .collect();
                night.push(NightSignal {
                    signal,
                    worker_id: chat.worker_id.clone(),
                    chat: chat.name.clone(),
                    project: chat.project.clone(),
                    at,
                    evidence,
                });
            }
        }
        dream.run.chats.push(read);
        read_chats.push(chat);
    }
    progress(read_chats.len(), None, &night);
    dream.run.chats_read = read_chats.len() as i64;
    let (ended, ended_reason) = if stopped {
        (DreamRunStatus::Stopped, Some("Stopped — you came back. The rest waits for the next dream.".to_owned()))
    } else {
        (DreamRunStatus::Done, None)
    };

    // ---- match → ledger ----
    let memories: Vec<UserMemory> = parts.memories.list().iter().map(|m| (**m).clone()).collect();
    let listed = format_memories(&memories);
    let mut ledger = decay_ledger(parts.store.read(|tx| tx.dreams().candidates()).await?, parts.clock.now_ms());
    if !night.is_empty() {
        let vars = [("SIGNALS", format_signals(&night)), ("CANDIDATES", format_candidates(&ledger, false))];
        let vars = [("SIGNALS", vars[0].1.as_str()), ("CANDIDATES", vars[1].1.as_str()), ("MEMORIES", listed.as_str())];
        let groups = match dream.ask::<DreamMatchOutput>(Step::Match, &vars).await {
            Ok(Some(answer)) => answer.groups,
            Ok(None) => return dream.fail("file tonight's signals", None).await,
            Err(why) => return dream.fail("file tonight's signals", Some(why)).await,
        };
        let (stem, mut n) = (dream.run.id.trim_start_matches("dr-").to_owned(), 0);
        let matched = apply_matches(ledger, &night, &groups, &memories, &offset_at, || {
            n += 1;
            format!("dc-{stem}-{n}")
        });
        ledger = matched.ledger;
        dream.run.dropped.known += matched.known;
        dream.run.dropped.declined += matched.declined;
        dream.run.dropped.invalid += matched.invalid;
    }
    let (kept, marks) =
        (ledger.clone(), read_chats.iter().map(|c| (c.worker_id.clone(), c.last_event_id)).collect::<Vec<_>>());
    parts
        .store
        .write(move |tx, _| {
            tx.dreams().replace_candidates(&kept)?;
            marks.iter().try_for_each(|(id, mark)| tx.dreams().set_watermark(id, *mark))
        })
        .await?;

    let ready: Vec<DreamCandidate> = ledger.iter().filter(|c| is_candidate_ready(c)).cloned().collect();
    dream.run.candidates = ledger.len() as i64;
    if ready.is_empty() {
        let waiting = match ledger.len() {
            0 => "Nothing worth remembering this time".to_owned(),
            1 => "Nothing ready yet — 1 idea is still gathering support".to_owned(),
            n => format!("Nothing ready yet — {n} ideas are still gathering support"),
        };
        return dream.finish(ended, ended_reason.or(Some(waiting))).await;
    }

    // ---- consolidate ----
    let digest = parts.profile_text.render("claude", None, None).text;
    let candidates = format_candidates(&ready, true);
    let vars = [("CANDIDATES", candidates.as_str()), ("MEMORIES", listed.as_str()), ("PROFILE", digest.as_str())];
    let parsed = match dream.ask::<DreamConsolidateOutput>(Step::Consolidate, &vars).await {
        Ok(Some(parsed)) => parsed,
        Ok(None) => return dream.fail("weigh what it noticed", None).await,
        Err(why) => return dream.fail("weigh what it noticed", Some(why)).await,
    };
    let mut settled: HashSet<String> = HashSet::new();
    for aside in parsed.set_aside.iter().filter(|a| ready.iter().any(|c| c.id == a.candidate)) {
        settled.insert(aside.candidate.clone());
        let dropped = &mut dream.run.dropped;
        *match aside.why {
            DreamSetAsideWhy::Known => &mut dropped.known,
            DreamSetAsideWhy::Declined => &mut dropped.declined,
            DreamSetAsideWhy::OneOff => &mut dropped.one_off,
            DreamSetAsideWhy::Product => &mut dropped.product,
            DreamSetAsideWhy::Weak => &mut dropped.weak,
        } += 1;
    }
    let check = check_proposals(&parsed.proposals, &memories, &ready);
    dream.run.dropped.invalid += check.invalid;
    dream.run.dropped.secret += check.secret;
    dream.run.dropped.style += check.style;
    settled.extend(parsed.proposals.iter().map(|p| p.candidate.clone()));
    let mut rejected: Vec<DreamRejected> = check.rejected;

    // ---- critic ----
    let mut finalists: Vec<CheckedProposal> = Vec::new();
    if !check.accepted.is_empty() {
        let proposals = format_proposals(&check.accepted);
        let vars = [("PROPOSALS", proposals.as_str()), ("MEMORIES", listed.as_str()), ("PROFILE", digest.as_str())];
        let verdicts = match dream.ask::<DreamCriticOutput>(Step::Critic, &vars).await {
            Ok(Some(answer)) => answer.verdicts,
            Ok(None) => return dream.fail("check its proposals", None).await,
            Err(why) => return dream.fail("check its proposals", Some(why)).await,
        };
        let (kept, refuted) = apply_verdicts(check.accepted, &verdicts);
        finalists = kept;
        dream.run.dropped.critic += refuted.len() as i64;
        rejected.extend(refuted);
    }

    // ---- file ----
    let mut filed = 0;
    for proposal in &finalists {
        let (support, _) = summarize_support(&proposal.candidate);
        let suggestion = UserMemorySuggestion {
            text: proposal.draft.text.clone(),
            category: serde_json::from_value(serde_json::to_value(proposal.draft.category).unwrap_or(Value::Null))
                .map_err(Error::storage)?,
            domain: Some(proposal.draft.domain),
            scope: proposal.scope.clone(),
            proposal: Some(UserMemoryProposal {
                kind: proposal.draft.kind,
                targets: proposal.targets.iter().cloned().map(UserMemoryId).collect(),
                confidence: None,
                support: Some(support),
            }),
        };
        let source = UserMemorySource::Dream(UserMemorySourceDream {
            dream_id: dream.run.id.clone(),
            evidence: evidence_of(&proposal.candidate),
            why: Some(proposal.draft.why.clone()),
        });
        let dropped = &mut dream.run.dropped;
        match parts.suggestions.suggest(suggestion, source) {
            Ok(result) if result.declined => dropped.declined += 1,
            Ok(result) if result.duplicate => dropped.known += 1,
            Ok(_) => filed += 1,
            // No room in the review queue: the candidate waits for it.
            Err(Error::LimitExceeded(_)) => {
                dropped.capped += 1;
                settled.remove(&proposal.candidate.id);
            }
            Err(_) => dropped.invalid += 1,
        }
    }
    // Settled candidates leave the ledger; one that truly recurs gathers support again.
    ledger.retain(|c| !settled.contains(&c.id));
    let kept = ledger.clone();
    parts.store.write(move |tx, _| tx.dreams().replace_candidates(&kept)).await?;
    dream.run.proposed = filed;
    dream.run.narrative = Some(parsed.narrative).filter(|n| filed > 0 && !n.is_empty());
    dream.run.candidates = ledger.len() as i64;
    rejected.truncate(REJECTED_MAX);
    dream.run.rejected = rejected;
    let nothing = match (filed, parsed.proposals.is_empty()) {
        (0, false) => Some("Nothing passed review this time".to_owned()),
        (0, true) => Some("Nothing worth proposing this time".to_owned()),
        _ => None,
    };
    dream.finish(ended, ended_reason.or(nothing)).await
}
