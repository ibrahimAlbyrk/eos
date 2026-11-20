//! The routes over notes: a page of them, one with what it was learned
//! from and how it helped, the user's own words or scope for it, forgetting
//! it, bringing it back within 30 days, and saying it is not right.

use std::sync::Arc;

use eos_contracts::{
    ExperienceComesBack, ExperienceConnection, ExperienceEditRequest, ExperienceHelp, ExperienceLearnedFrom,
    ExperienceNoteDetail, ExperienceNoteList, ExperienceVersion, NotRightRequest,
};
use eos_core::store::{MEM_EVIDENCE_PER_NOTE, NoteQuery, StoredEvidence, StoredNote};
use eos_domain::experience::clean::clean;
use eos_domain::experience::{NoteBody, NoteKind, NoteState, Scope, ScopeLevel};
use eos_memory::forget::{Restored, forget_in, restore_in};
use eos_memory::merge::{MEMORY_CHANGE, version};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::path::percent_decode;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use super::{Api, view};

const PAGE: i64 = 50;
const PAGE_MAX: i64 = 100;
/// Uses counted for "came back so often".
const RECALLS_COUNTED: i64 = 10_000;
/// What the user says was wrong is kept this short.
const NOT_RIGHT_CHARS: usize = 200;

fn note_id(req: &Request) -> String {
    let raw = req.param("id").unwrap_or_default();
    percent_decode(raw).map(|id| id.into_owned()).unwrap_or_else(|| raw.to_owned())
}

fn not_found() -> ApiError {
    ApiError::NotFound("note not found".into())
}

/// `scope=level` or `scope=level:key`.
fn scope_filter(text: &str) -> Option<(ScopeLevel, Option<String>)> {
    let (level, key) = match text.split_once(':') {
        Some((level, key)) => (level, Some(key.to_owned())),
        None => (text, None),
    };
    Some((ScopeLevel::parse(level)?, key))
}

fn query(req: &Request) -> Result<NoteQuery, ApiError> {
    let given = |key: &str| req.query().get(key).filter(|v| !v.is_empty()).map(|v| v.into_owned());
    let bad = |key: &'static str| move || ApiError::invalid([(key, "Unknown value")]);
    let scope = given("scope").map(|s| scope_filter(&s).ok_or_else(bad("scope"))).transpose()?;
    let kind = given("kind").map(|k| NoteKind::parse(&k).ok_or_else(bad("kind"))).transpose()?;
    let state = given("state").map(|s| NoteState::parse(&s).ok_or_else(bad("state"))).transpose()?;
    let before = given("cursor")
        .map(|c| {
            let (at, id) = c.split_once('.').ok_or_else(bad("cursor"))?;
            Ok::<_, ApiError>((at.parse().map_err(|_| bad("cursor")())?, id.to_owned()))
        })
        .transpose()?;
    let limit = given("limit").and_then(|l| l.parse::<i64>().ok()).unwrap_or(PAGE).clamp(1, PAGE_MAX);
    let forgotten = given("forgotten").is_some_and(|f| f == "true");
    Ok(NoteQuery { scope, kind, state, words: given("q"), before, limit: limit + 1, forgotten })
}

async fn list(api: Arc<Api>, req: Request) -> Result<Response, ApiError> {
    let mut query = query(&req)?;
    let limit = query.limit - 1;
    query.limit = limit + 1;
    let (mut notes, first) = api
        .store
        .read(move |tx| {
            let notes = tx.mem_notes().list(&query)?;
            let first = view::first_evidence_in(tx, &notes)?;
            Ok((notes, first))
        })
        .await?;
    let next_cursor = (notes.len() as i64 > limit).then(|| {
        let last = &notes[limit as usize - 1].note;
        format!("{}.{}", last.updated_at, last.id)
    });
    notes.truncate(limit as usize);
    let labels = view::labels(api.project_keys.as_ref(), notes.iter().map(|n| n.note.scope.clone()).collect()).await;
    let notes = notes.iter().map(|n| view::row(n, &first, &labels)).collect();
    Ok(Response::json(200, &ExperienceNoteList { notes, next_cursor }))
}

/// What brings a note back: its situation, else the things it is about.
fn situation(note: &StoredNote, connected: &[ExperienceConnection]) -> String {
    match &note.note.body {
        NoteBody::Lesson { situation, .. } | NoteBody::Skill { situation, .. } if !situation.is_empty() => {
            situation.clone()
        }
        _ => connected.iter().map(|c| c.label.as_str()).collect::<Vec<_>>().join(", "),
    }
}

async fn detail(api: Arc<Api>, id: String) -> Result<Response, ApiError> {
    let found = api
        .store
        .read(move |tx| {
            let Some(note) = tx.mem_notes().find(&id)? else { return Ok(None) };
            let evidence = tx.mem_evidence().of_note(&id, MEM_EVIDENCE_PER_NOTE)?;
            let links = tx.mem_graph().links(&[id.clone()])?;
            let other = |a: &str, b: &str| if a == id { b.to_owned() } else { a.to_owned() };
            let hook_ids: Vec<String> = links.iter().filter(|l| l.rel == "about").map(|l| other(&l.a, &l.b)).collect();
            let hooks = tx.mem_graph().hooks(&hook_ids)?;
            let mut next = Vec::new();
            for link in links.iter().filter(|l| l.rel != "about") {
                next.extend(tx.mem_notes().find(&other(&link.a, &link.b))?.filter(|n| n.forgotten_at.is_none()));
            }
            let mut shown = vec![note.clone()];
            shown.extend(next.iter().cloned());
            let first = view::first_evidence_in(tx, &shown)?;
            let recalled = tx.mem_uses().times_of_note(&id, RECALLS_COUNTED)?.len() as i64;
            let versions = tx.mem_versions().of_note(&id)?;
            Ok(Some((note, evidence, hooks, next, first, recalled, versions)))
        })
        .await?;
    let (note, evidence, hooks, next, first, recalled, versions) = found.ok_or_else(not_found)?;
    let scopes = std::iter::once(&note).chain(&next).map(|n| n.note.scope.clone()).collect();
    let labels = view::labels(api.project_keys.as_ref(), scopes).await;
    let connected_to: Vec<ExperienceConnection> = hooks
        .iter()
        .map(|h| ExperienceConnection {
            kind: h.kind.as_str().to_owned(),
            label: if h.label.is_empty() { h.key.clone() } else { h.label.clone() },
        })
        .collect();
    let learned_from = evidence
        .iter()
        .rev()
        .map(|e: &StoredEvidence| ExperienceLearnedFrom { at: e.at, text: e.summary.clone() })
        .collect();
    let counters = note.counters;
    Ok(Response::json(
        200,
        &ExperienceNoteDetail {
            note: view::row(&note, &first, &labels),
            comes_back_when: ExperienceComesBack {
                situation: situation(&note, &connected_to),
                reminder: note.note.text.clone(),
            },
            learned_from,
            connected_to,
            next_to: next.iter().map(|n| view::row(n, &first, &labels)).collect(),
            help: ExperienceHelp {
                recalled,
                used: counters.used,
                helped: counters.helped,
                hurt: counters.hurt,
                last_used_at: counters.last_used_at,
            },
            versions: versions.iter().map(|v| ExperienceVersion { rev: v.rev, at: v.at, why: v.why.clone() }).collect(),
            device: note.note.device.clone(),
        },
    ))
}

/// What an edit came to.
enum Edited {
    Done,
    Gone,
    Changed(i64),
}

async fn edit(api: Arc<Api>, id: String, body: ExperienceEditRequest) -> Result<Response, ApiError> {
    let text = match &body.text {
        Some(text) => Some(
            clean(&api.scrubber, text.trim())
                .map_err(|_| ApiError::invalid([("text", "It holds something that may not be kept")]))?,
        ),
        None => None,
    };
    let scope = match &body.scope {
        Some(s) => {
            let level = ScopeLevel::parse(&s.level).ok_or_else(|| ApiError::invalid([("scope", "Unknown level")]))?;
            let key = if level == ScopeLevel::Everywhere { String::new() } else { s.key.clone() };
            if level != ScopeLevel::Everywhere && key.is_empty() {
                return Err(ApiError::invalid([("scope", "A key is needed")]));
            }
            Some(Scope { level, key })
        }
        None => None,
    };
    let (device, now, base_rev, lookup) = (api.device.clone(), api.clock.now_ms(), body.base_rev, id.clone());
    let edited = api
        .store
        .write(move |tx, out| {
            let Some(stored) = tx.mem_notes().find(&lookup)?.filter(|n| n.forgotten_at.is_none()) else {
                return Ok(Edited::Gone);
            };
            if stored.rev != base_rev {
                return Ok(Edited::Changed(stored.rev));
            }
            let mut note = stored.note.clone();
            if let Some(text) = text {
                note.text = text;
            }
            if let Some(scope) = scope {
                note.scope = scope;
            }
            note.updated_at = now.max(note.updated_at);
            note.device = device;
            tx.mem_notes().update(&note, &stored.cues, stored.rev + 1)?;
            tx.mem_versions().insert(&version(&note, stored.rev + 1, "edited", now))?;
            out.push(
                MEMORY_CHANGE,
                &eos_contracts::ExperienceChange { ids: vec![lookup.clone()], action: "changed".into() },
            );
            Ok(Edited::Done)
        })
        .await?;
    match edited {
        Edited::Done => detail(api, id).await,
        Edited::Gone => Err(not_found()),
        Edited::Changed(rev) => Ok(Response::json(409, &json!({ "error": "changed", "rev": rev }))),
    }
}

async fn forget(api: Arc<Api>, id: String) -> Result<Response, ApiError> {
    let (now, lookup) = (api.clock.now_ms(), id.clone());
    let known = api
        .store
        .write(move |tx, out| {
            if tx.mem_notes().find(&lookup)?.is_none() {
                return Ok(false);
            }
            forget_in(tx, out, &lookup, now)?;
            Ok(true)
        })
        .await?;
    if !known {
        return Err(not_found());
    }
    tracing::info!(note = %id, "memory: note forgotten");
    detail(api, id).await
}

async fn restore(api: Arc<Api>, id: String) -> Result<Response, ApiError> {
    let (now, device, lookup) = (api.clock.now_ms(), api.device.clone(), id.clone());
    let restored = api.store.write(move |tx, out| restore_in(tx, out, &lookup, &device, now)).await?;
    match restored {
        Restored::Done => detail(api, id).await,
        Restored::NotForgotten => Err(not_found()),
        Restored::TooLate => Ok(Response::json(409, &json!({ "error": "too_late" }))),
    }
}

async fn not_right(api: Arc<Api>, id: String, body: NotRightRequest) -> Result<Response, ApiError> {
    if api.credit.not_right(&id).await?.is_none() {
        return Err(not_found());
    }
    let said = body.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if let Some(said) = said.and_then(|n| clean(&api.scrubber, n).ok()) {
        let evidence = StoredEvidence {
            id: api.ids.memory_row_id(),
            note_id: id.clone(),
            kind: "not_right".into(),
            summary: said.chars().take(NOT_RIGHT_CHARS).collect(),
            worker_id: body.worker_id.clone(),
            row_from: None,
            row_to: None,
            run_id: body.run_id.clone(),
            at: api.clock.now_ms(),
            device: api.device.clone(),
        };
        api.store.write(move |tx, _| tx.mem_evidence().insert(&evidence)).await?;
    }
    detail(api, id).await
}

pub(crate) fn all(api: &Arc<Api>) -> Vec<RouteDef> {
    let at = api.clone();
    let list = RouteDef::get("/api/memory/notes", move |req: Request| list(at.clone(), req));
    let at = api.clone();
    let one = RouteDef::get("/api/memory/notes/{id}", move |req: Request| detail(at.clone(), note_id(&req)));
    let at = api.clone();
    let put = RouteDef::put("/api/memory/notes/{id}", move |req: Request| {
        let at = at.clone();
        async move {
            let body: ExperienceEditRequest = req.parse()?;
            edit(at, note_id(&req), body).await
        }
    });
    let at = api.clone();
    let delete = RouteDef::delete("/api/memory/notes/{id}", move |req: Request| forget(at.clone(), note_id(&req)));
    let at = api.clone();
    let back = RouteDef::post("/api/memory/notes/{id}/restore", move |req: Request| restore(at.clone(), note_id(&req)));
    let at = api.clone();
    let wrong = RouteDef::post("/api/memory/notes/{id}/not-right", move |req: Request| {
        let at = at.clone();
        async move {
            let body: NotRightRequest = req.parse()?;
            not_right(at, note_id(&req), body).await
        }
    });
    let read = Access::ui_token().phone_user(Tier::Read);
    vec![
        list.access(read),
        one.access(read),
        put.access(Access::ui_token()),
        delete.access(Access::ui_token()),
        back.access(Access::ui_token()),
        wrong.access(Access::ui_token().phone_user(Tier::Low)),
    ]
}
