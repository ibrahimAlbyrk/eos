//! Starting a chat, an orchestrator or a worker.

use std::path::Path;

use eos_contracts::{
    FOCUSED_ROLE, NameSource, SpawnOrchestratorRequest, SpawnOrchestratorRequestMode, SpawnWorkerRequest,
    WorkerIsolation,
};
use eos_core::{Alphabet, Error};
use eos_domain::ProviderIdentity;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::SpawnRequest;
use eos_workers::resolve::{apply_defaults, is_restrictive, materialize_tool_scope, resolve_definition_name};
use serde_json::json;

use crate::AgentsModule;

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![orchestrator(m.clone()), worker(m.clone())]
}

/// How long a name taken from a prompt may be.
const PROMPT_NAME_CHARS: usize = 40;

/// A nameless chat is named after the start of its first message, until
/// something names it properly.
fn prompt_name(prompt: &str) -> Option<String> {
    let flat = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= PROMPT_NAME_CHARS {
        return Some(flat);
    }
    let head: String = chars[..PROMPT_NAME_CHARS].iter().collect();
    Some(format!("{}…", head.trim_end()))
}

fn name_of<T: serde::Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned))
}

/// A tier name or alias as the model it stands for.
fn model_for(asked: Option<&str>) -> String {
    let claude = ProviderIdentity::claude();
    claude.resolve_tier(asked.unwrap_or_else(|| claude.default_tier_name())).to_owned()
}

fn orchestrator(m: AgentsModule) -> RouteDef {
    RouteDef::post("/orchestrators", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SpawnOrchestratorRequest = req.parse()?;
            let focused = body.mode == Some(SpawnOrchestratorRequestMode::Focused);
            let prompt = body.prompt.clone().unwrap_or_default();
            let given = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_owned);
            let name = given
                .clone()
                .or_else(|| prompt_name(&prompt))
                .unwrap_or_else(|| format!("agent-{}", m.ids.token(Alphabet::Base36, 3)));
            // A chat with no folder gets a scratch folder of its own; that folder is the files feature's to make.
            let Some(cwd) = body.cwd.clone().filter(|c| !c.is_empty() && body.scratch.is_none()) else {
                return Err(ApiError::status_with(501, "a chat without a folder is not available yet"));
            };
            let id = if focused { m.ids.worker_id() } else { m.ids.orchestrator_id() };
            let request = SpawnRequest {
                prompt: prompt.clone(),
                cwd: Some(cwd),
                name: Some(name.clone()),
                name_source: Some(if given.is_some() { NameSource::User } else { NameSource::Default }),
                model: Some(model_for(body.model.as_deref())),
                effort: Some(body.effort.clone().unwrap_or_else(|| "xhigh".to_owned())),
                is_orchestrator: !focused,
                role: focused.then(|| FOCUSED_ROLE.to_owned()),
                permission_mode: body
                    .permission_mode
                    .as_ref()
                    .and_then(name_of)
                    .or(Some("bypassPermissions".to_owned())),
                fixed_id: Some(id),
                record_prompt: true,
                ..SpawnRequest::default()
            };
            let spawned = m.sessions.spawn(request).await?;
            let mut answer = json!({"id": spawned.id, "port": 0});
            if let (Some(msg), Some(fields)) = (spawned.boot_msg_id, answer.as_object_mut()) {
                fields.insert("bootMsgId".into(), msg.into());
            }
            if let Some(fields) = answer.as_object_mut() {
                fields.insert("name".into(), name.into());
            }
            Ok(Response::json(201, &answer))
        }
    })
    .access(Access::open().phone(Tier::High))
}

/// The mode a spawned worker starts in when nothing names one: its parent's,
/// looked up the chain.
async fn inherited_mode(m: &AgentsModule, parent_id: &str) -> Result<Option<String>, Error> {
    let start = parent_id.to_owned();
    m.store
        .read(move |tx| {
            let mut at = Some(start);
            let mut hops = 0;
            while let Some(id) = at.take().filter(|_| hops < 32) {
                let Some(row) = tx.workers().find(&id)? else { break };
                if row.permission_mode.is_some() {
                    return Ok(row.permission_mode);
                }
                at = row.parent_id;
                hops += 1;
            }
            Ok(None)
        })
        .await
}

fn worker(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SpawnWorkerRequest = req.parse()?;
            let raw: serde_json::Value = req.json().unwrap_or_default();
            let has = |field: &str| raw.get(field).is_some_and(|v| !v.is_null());
            // A prompt from a template is the prompts feature's to render.
            if body.prompt_template.is_some() && body.prompt.is_none() {
                return Err(ApiError::status_with(501, "spawning from a prompt template is not available yet"));
            }
            let Some(prompt) = body.prompt.clone().filter(|p| !p.is_empty()) else {
                return Err(ApiError::Validation("resolved prompt is empty".into()));
            };
            if body.r#loop.is_some() {
                return Err(ApiError::status_with(501, "a dynamic loop cannot be armed at spawn yet"));
            }
            if let Some(target) = &body.workspace_of
                && m.worker(target).await?.is_some_and(|w| w.is_archived())
            {
                return Err(ApiError::Conflict("workspaceOf target is archived — restore it first".into()));
            }

            // Every worker starts from a definition: its defaults, its tool scope.
            let role = body.role.as_ref().and_then(name_of);
            let definition_name = resolve_definition_name(body.from.as_deref(), role.as_deref()).to_owned();
            let lookup = body.worktree_from.clone().or(body.cwd.clone());
            let owner = body.definition_owner_id.clone().or(body.parent_id.clone());
            let found =
                m.definitions.resolve(&definition_name, lookup.as_deref().map(Path::new), owner.as_deref()).await?;
            let Some(definition) = found else {
                return Err(ApiError::Validation(format!("unknown worker definition: {definition_name}")));
            };
            let defaults = apply_defaults(&definition, has);
            let scope = if has("toolsAllow") || has("toolsDeny") || has("editRegex") {
                eos_contracts::ToolScope {
                    allow: body.tools_allow.clone().unwrap_or_default(),
                    deny: body.tools_deny.clone().unwrap_or_default(),
                    edit_regex: body.edit_regex.clone(),
                }
            } else {
                materialize_tool_scope(&definition)
            };
            let tool_scope =
                is_restrictive(&scope).then(|| serde_json::to_string(&scope)).transpose().map_err(Error::storage)?;

            // Where it works: its own worktree of the repository it is given, or the folder as it is.
            let wants_tree = defaults.isolation == Some(WorkerIsolation::Worktree);
            let (cwd, worktree_from) = match (body.cwd.clone(), body.worktree_from.clone(), body.workspace_of.is_some())
            {
                (_, _, true) => (None, None),
                (cwd, Some(from), _) => (cwd.filter(|_| false), Some(from)),
                (Some(cwd), None, _) if wants_tree => (None, Some(cwd)),
                (cwd, None, _) => (cwd, None),
            };
            let mode = match body
                .permission_mode
                .as_ref()
                .and_then(name_of)
                .or(defaults.permission_mode.as_ref().and_then(name_of))
            {
                Some(mode) => Some(mode),
                None => match &body.parent_id {
                    Some(parent) => inherited_mode(&m, parent).await?,
                    None => None,
                },
            };
            let model = defaults.model.clone().or(body.model.clone());
            let request = SpawnRequest {
                prompt,
                cwd,
                worktree_from,
                branch: body.branch.clone(),
                name: body.name.clone(),
                parent_id: body.parent_id.clone(),
                model: model.as_deref().map(|m| model_for(Some(m))),
                effort: defaults.effort.as_ref().and_then(name_of).or(body.effort.clone()),
                role,
                workspace_of: body.workspace_of.clone(),
                collaborate: defaults.collaborate.or(body.collaborate).unwrap_or(false),
                backend_profile: defaults.backend_profile.clone(),
                worker_definition: Some(definition.name.clone()),
                tool_scope,
                permission_mode: mode,
                // The operator's own spawn shows its prompt as their first message.
                record_prompt: body.parent_id.is_none(),
                ..SpawnRequest::default()
            };
            let isolation =
                if request.worktree_from.is_some() || request.workspace_of.is_some() { "worktree" } else { "cwd" };
            let spawned = m.sessions.spawn(request).await?;
            let mut answer = json!({"id": spawned.id, "port": 0});
            if let Some(fields) = answer.as_object_mut() {
                if let Some(msg) = spawned.boot_msg_id {
                    fields.insert("bootMsgId".into(), msg.into());
                }
                fields.insert("isolation".into(), isolation.into());
            }
            Ok(Response::json(201, &answer))
        }
    })
    .access(Access::open().phone(Tier::High))
}

#[cfg(test)]
mod tests {
    use super::*;

    // manager/shared/names.ts
    #[test]
    fn a_chat_is_named_after_the_start_of_its_first_message() {
        assert_eq!(prompt_name("  Fix   the\nparser "), Some("Fix the parser".into()));
        assert_eq!(prompt_name(" \n "), None);
        let long = "a".repeat(39) + " bcd";
        assert_eq!(prompt_name(&long), Some(format!("{}…", "a".repeat(39))));
        assert_eq!(model_for(None), model_for(Some(ProviderIdentity::claude().default_tier_name())));
    }
}
