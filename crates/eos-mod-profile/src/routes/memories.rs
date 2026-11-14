//! The memory routes. Agents may only search and suggest; keeping, editing,
//! dismissing and deleting are the user's.

use std::sync::Arc;

use eos_contracts::{
    UserMemory, UserMemoryCreateRequest, UserMemoryId, UserMemoryStatus, UserMemorySuggestRequest,
    UserMemoryUpdateRequest,
};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;

use super::failed;
use crate::agents::{AgentMemory, SEARCH_LIMIT_DEFAULT};
use crate::memories::{MemoryInput, MemoryPatch};

#[derive(Serialize)]
struct MemoryBody<'a> {
    memory: Option<&'a UserMemory>,
}

#[derive(Serialize)]
struct MemoriesBody<'a> {
    memories: Vec<&'a UserMemory>,
}

/// What keeping every suggestion left: a `null` where a proposal retired a memory.
#[derive(Serialize)]
struct KeptBody<'a> {
    memories: Vec<Option<&'a UserMemory>>,
}

fn memories(found: &[Arc<UserMemory>]) -> Response {
    Response::json(200, &MemoriesBody { memories: found.iter().map(Arc::as_ref).collect() })
}

#[derive(Serialize)]
struct SuggestBody<'a> {
    memory: &'a UserMemory,
    duplicate: bool,
    declined: bool,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

#[derive(Serialize)]
struct NoRoute<'a> {
    error: &'static str,
    path: &'a str,
}

fn memory(status: u16, memory: Option<&UserMemory>) -> Response {
    Response::json(status, &MemoryBody { memory })
}

fn status_name(status: UserMemoryStatus) -> &'static str {
    match status {
        UserMemoryStatus::Active => "active",
        UserMemoryStatus::Suggested => "suggested",
        UserMemoryStatus::Dismissed => "dismissed",
    }
}

/// The `{id}` of the path. Today's routes exist only for `um-<letters and
/// digits>`: anything else is no route at all; an id of that shape with the
/// wrong length is a bad request.
fn id(req: &Request) -> Result<&str, Response> {
    let id = req.param("id").unwrap_or_default();
    let shaped = id
        .strip_prefix("um-")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    if !shaped {
        return Err(Response::json(404, &NoRoute { error: "not found", path: req.path() }));
    }
    match eos_contracts::check(&UserMemoryId(id.to_owned())) {
        Ok(()) => Ok(id),
        Err(e) => Err(ApiError::from(e).into_response()),
    }
}

/// `Math.min(20, Math.max(1, Number(limit) || 8))`, then what `slice` does
/// with a fraction.
fn limit(raw: Option<&str>) -> usize {
    let text = eos_domain::text::js_trim(raw.unwrap_or_default());
    let number = match text {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) => {
            text.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    };
    if number.is_nan() || number == 0.0 {
        return SEARCH_LIMIT_DEFAULT;
    }
    // Clamped to 1..=20 first: the cast cannot overflow.
    number.clamp(1.0, 20.0) as usize
}

pub(crate) fn all(agents: &Arc<AgentMemory>) -> Vec<RouteDef> {
    // Kept and waiting memories (`?status=` narrows; dismissed tombstones only
    // on request): the Memory view groups them.
    let list = {
        let agents = agents.clone();
        RouteDef::get("/api/user-memories", move |req: Request| {
            let agents = agents.clone();
            async move {
                let status = req.query().get("status").filter(|status| !status.is_empty());
                let wanted = |m: &Arc<UserMemory>| match &status {
                    Some(status) => status_name(m.status) == status.as_ref(),
                    None => m.status != UserMemoryStatus::Dismissed,
                };
                let found: Vec<Arc<UserMemory>> = agents.memories.list().into_iter().filter(wanted).collect();
                Ok(memories(&found))
            }
        })
    };
    let create = {
        let agents = agents.clone();
        RouteDef::post("/api/user-memories", move |req: Request| {
            let agents = agents.clone();
            async move {
                let body: UserMemoryCreateRequest = req.parse()?;
                let input = MemoryInput {
                    text: body.text,
                    category: body.category,
                    domain: body.domain,
                    scope: body.scope,
                    tier: body.tier,
                };
                Ok(memory(201, Some(&*agents.memories.create(input)?)))
            }
        })
    };
    let suggest = {
        let agents = agents.clone();
        RouteDef::post("/api/user-memories/suggest", move |req: Request| {
            let agents = agents.clone();
            async move {
                let agent = agents.caller(req.headers.get("x-eos-agent-id")).await?;
                agents.may_suggest(agent.as_ref())?;
                let body: UserMemorySuggestRequest = req.parse()?;
                let Some(agent) = agent else { return Err(ApiError::Internal("no agent".into())) };
                let result = agents.suggest(&agent, body)?;
                let status = if result.duplicate { 200 } else { 201 };
                let body =
                    SuggestBody { memory: &result.memory, duplicate: result.duplicate, declined: result.declined };
                Ok(Response::json(status, &body))
            }
        })
    };
    // An agent searches its own session's project; the dashboard names one (`?project=`).
    let search = {
        let agents = agents.clone();
        RouteDef::get("/api/user-memories/search", move |req: Request| {
            let agents = agents.clone();
            async move {
                let agent = agents.caller(req.headers.get("x-eos-agent-id")).await?;
                let query = req.query();
                let project = query.get("project").filter(|project| !project.is_empty());
                let text = query.get("q").unwrap_or_default();
                let limit = limit(query.get("limit").as_deref());
                Ok(memories(&agents.search(agent.as_ref(), project.as_deref(), &text, limit)?))
            }
        })
    };
    let approve_all = {
        let agents = agents.clone();
        RouteDef::post("/api/user-memories/approve-all", move |_req: Request| {
            let agents = agents.clone();
            async move {
                let kept = agents.memories.approve_all()?;
                Ok(Response::json(200, &KeptBody { memories: kept.iter().map(Option::as_deref).collect() }))
            }
        })
    };
    let update = {
        let agents = agents.clone();
        RouteDef::put("/api/user-memories/{id}", move |req: Request| {
            let agents = agents.clone();
            async move {
                let id = match id(&req) {
                    Ok(id) => id,
                    Err(refused) => return Ok(refused),
                };
                let body: UserMemoryUpdateRequest = req.parse()?;
                let patch = MemoryPatch {
                    text: body.text,
                    category: body.category,
                    domain: body.domain,
                    scope: body.scope,
                    tier: body.tier,
                };
                agents
                    .memories
                    .update(id, patch, body.base_rev)
                    .map_or_else(failed, |saved| Ok(memory(200, Some(&*saved))))
            }
        })
    };
    let delete = {
        let agents = agents.clone();
        RouteDef::delete("/api/user-memories/{id}", move |req: Request| {
            let agents = agents.clone();
            async move {
                let id = match id(&req) {
                    Ok(id) => id,
                    Err(refused) => return Ok(refused),
                };
                agents.memories.remove(id)?;
                Ok(Response::json(200, &Done { ok: true }))
            }
        })
    };
    let approve = {
        let agents = agents.clone();
        RouteDef::post("/api/user-memories/{id}/approve", move |req: Request| {
            let agents = agents.clone();
            async move {
                let id = match id(&req) {
                    Ok(id) => id,
                    Err(refused) => return Ok(refused),
                };
                Ok(memory(200, agents.memories.approve(id)?.as_deref()))
            }
        })
    };
    let dismiss = {
        let agents = agents.clone();
        RouteDef::post("/api/user-memories/{id}/dismiss", move |req: Request| {
            let agents = agents.clone();
            async move {
                let id = match id(&req) {
                    Ok(id) => id,
                    Err(refused) => return Ok(refused),
                };
                agents.memories.dismiss(id)?;
                Ok(Response::json(200, &Done { ok: true }))
            }
        })
    };
    vec![
        list.access(Access::open()),
        create.access(Access::ui_token()),
        suggest.access(Access::open()),
        search.access(Access::open()),
        approve_all.access(Access::ui_token()),
        update.access(Access::ui_token()),
        delete.access(Access::ui_token()),
        approve.access(Access::ui_token()),
        dismiss.access(Access::ui_token()),
    ]
}

#[cfg(test)]
mod tests {
    use super::limit;

    #[test]
    fn the_search_limit_reads_like_javascript() {
        // Math.min(20, Math.max(1, Number(x) || 8)), then slice(0, n)
        for (raw, want) in [
            (None, 8),
            (Some(""), 8),
            (Some("3"), 3),
            (Some(" 7 "), 7),
            (Some("0"), 8),
            (Some("abc"), 8),
            (Some("-5"), 1),
            (Some("2.5"), 2),
            (Some("0.5"), 1),
            (Some("1e1"), 10),
            (Some("99"), 20),
            (Some("Infinity"), 20),
            (Some("inf"), 8),
            (Some("nan"), 8),
        ] {
            assert_eq!(limit(raw), want, "{raw:?}");
        }
    }
}
