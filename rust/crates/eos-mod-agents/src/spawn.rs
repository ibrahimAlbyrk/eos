//! Starting a chat, an orchestrator or a worker.

use std::collections::HashSet;
use std::path::Path;

use eos_contracts::{
    DEFAULT_WORKER_DEFINITION, FOCUSED_ROLE, NameSource, PermissionMode, SettingValue, SpawnOrchestratorRequest,
    SpawnOrchestratorRequestMode, SpawnWorkerRequest, SpawnWorkerResponseIsolation, UserSettings, WorkerIsolation,
};
use eos_core::{Alphabet, Error};
use eos_domain::ProviderIdentity;
use eos_domain::config::{Config, current_backend_kind};
use eos_domain::worktree_policy::{Isolation, resolve_spawn_isolation};
use eos_platform::expand_path;
use eos_prompts::service::no_values;
use eos_prompts::template::VariableScope;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::SpawnRequest;
use eos_workers::resolve::{
    apply_defaults, is_restrictive, materialize_tool_scope, resolve_combined_model, resolve_definition_name, tool_scope,
};
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

/// A backend an explicit pick names must be the engine every session runs on.
fn engine_runs(m: &AgentsModule, kind: &str) -> Result<(), Error> {
    if current_backend_kind(kind) == m.sessions.descriptor().kind {
        return Ok(());
    }
    Err(Error::Validation(format!("backend \"{kind}\" is not enabled")))
}

/// The backend profile a spawn names must be one the engine runs.
fn profile_runs(m: &AgentsModule, config: &Config, profile: &str) -> Result<(), Error> {
    let kind = config.backends.get(profile).and_then(|p| name_of(&p.kind));
    match kind {
        Some(kind) => {
            engine_runs(m, &kind).map_err(|_| Error::Validation(format!("backend \"{profile}\" is not enabled")))
        }
        None => Err(Error::Validation(format!("backend \"{profile}\" is not enabled"))),
    }
}

fn setting_on(settings: &UserSettings, key: &str) -> bool {
    matches!(settings.get(key), Some(SettingValue::Flag(true)))
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
            // A focused session always runs on the engine; the operator's provider pick is an orchestrator's.
            let config = m.spawning.config.current();
            let is_backend = |name: &str| config.backends.contains_key(name);
            let pinned = body.backend_profile.as_deref().filter(|_| !focused);
            let (model, profile) = resolve_combined_model(body.model.as_deref(), pinned, is_backend);
            let profile = profile.filter(|_| !focused);
            if let Some(kind) = body.backend_kind.as_deref().filter(|_| !focused && profile.is_none()) {
                engine_runs(&m, kind)?;
            }
            if let Some(profile) = &profile {
                profile_runs(&m, &config, profile)?;
            }
            let id = if focused { m.ids.worker_id() } else { m.ids.orchestrator_id() };
            // A chat with no folder gets a scratch folder of its own, made
            // once the request is known to be valid.
            let scratch = body.scratch.is_some();
            let cwd = match &body.cwd {
                _ if scratch => m.spawning.scratch.create(&id).await?,
                Some(cwd) => expand_path(cwd),
                None => return Err(ApiError::Validation("exactly one of cwd or scratch required".into())),
            };
            let request = SpawnRequest {
                prompt: prompt.clone(),
                cwd: Some(cwd.clone()),
                scratch,
                name: Some(name.clone()),
                name_source: Some(if given.is_some() { NameSource::User } else { NameSource::Default }),
                model: Some(model_for(model.as_deref())),
                effort: Some(body.effort.clone().unwrap_or_else(|| "xhigh".to_owned())),
                is_orchestrator: !focused,
                role: focused.then(|| FOCUSED_ROLE.to_owned()),
                backend_profile: profile,
                permission_mode: body
                    .permission_mode
                    .as_ref()
                    .and_then(name_of)
                    .or(Some("bypassPermissions".to_owned())),
                fixed_id: Some(id),
                record_prompt: true,
                ..SpawnRequest::default()
            };
            let spawned = match m.sessions.spawn(request).await {
                Ok(spawned) => spawned,
                Err(e) => {
                    if scratch {
                        m.spawning.scratch.remove(&cwd).await;
                    }
                    return Err(e.into());
                }
            };
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

/// What `POST /workers` started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedWorker {
    pub id: String,
    /// The message id its first prompt went out with.
    pub boot_msg_id: Option<i64>,
    /// Its own worktree, or the folder as it is.
    pub isolation: SpawnWorkerResponseIsolation,
}

impl AgentsModule {
    /// The mode a spawned worker starts in when nothing names one: the
    /// nearest one up its parent chain (`SqlBackedModeResolver`).
    async fn inherited_mode(&self, parent_id: &str) -> Result<String, Error> {
        let start = parent_id.to_owned();
        self.store
            .read(move |tx| {
                let mut seen = HashSet::new();
                let mut at = Some(start);
                while let Some(id) = at.take().filter(|id| seen.insert(id.clone())) {
                    let Some(row) = tx.workers().find(&id)? else { break };
                    let mode = row.permission_mode.filter(|m| {
                        serde_json::from_value::<PermissionMode>(serde_json::Value::String(m.clone())).is_ok()
                    });
                    if let Some(mode) = mode {
                        return Ok(mode);
                    }
                    at = row.parent_id;
                }
                Ok("bypassPermissions".to_owned())
            })
            .await
    }

    /// The first message of a worker: the prompt as given, or a library
    /// template rendered with the request's values.
    fn boot_prompt(&self, body: &SpawnWorkerRequest) -> Result<String, Error> {
        let literal = body.prompt.clone().filter(|p| !p.is_empty());
        let prompt = match (literal, &body.prompt_template) {
            (Some(prompt), _) => prompt,
            (None, Some(template)) => {
                let values: VariableScope = template
                    .vars
                    .iter()
                    .flatten()
                    .map(|(name, value)| (name.clone(), serde_json::Value::String(value.clone())))
                    .collect();
                let rendered = self.spawning.prompts.render(&template.id, &values, &no_values());
                rendered.map_err(|e| Error::Validation(format!("promptTemplate render failed: {e}")))?.trim().to_owned()
            }
            (None, None) => String::new(),
        };
        if prompt.is_empty() {
            return Err(Error::Validation("resolved prompt is empty".into()));
        }
        Ok(prompt)
    }

    /// Starts a worker from a request (`manager/commands/handlers/spawn-worker.ts`):
    /// its definition's defaults and tool scope, where it works, the mode it
    /// inherits. The route and an agent's `spawn_worker`
    /// tool both start workers here.
    pub async fn spawn_worker(&self, body: SpawnWorkerRequest) -> Result<SpawnedWorker, Error> {
        let m = self;
        let raw = serde_json::to_value(&body).map_err(Error::storage)?;
        let has = |field: &str| raw.get(field).is_some_and(|v| !v.is_null());
        let config = m.spawning.config.current();
        let settings = m.spawning.settings.read();
        let prompt = m.boot_prompt(&body)?;
        // A loop that could not be armed must not leave a worker behind: checked before anything is made.
        if body.r#loop.is_some() {
            if !config.r#loop.enabled {
                return Err(Error::Validation("dynamic loop is disabled — set config.loop.enabled".into()));
            }
            let Some(parent_id) = &body.parent_id else {
                return Err(Error::Validation(
                    "a dynamic loop can only be armed on a worker spawned by an orchestrator".into(),
                ));
            };
            let parent = m.worker(parent_id).await?.ok_or_else(|| Error::not_found("worker", parent_id))?;
            if !parent.is_orchestrator {
                return Err(Error::PermissionDenied(format!("worker {parent_id} is not an orchestrator")));
            }
            // Nothing checks a loop's goal yet: an armed loop would hold its worker's report for
            // ever. Refused until the goal checks run (`eos_sessions::loops::attach_loop` arms
            // one), so the orchestrator can spawn without it.
            return Err(Error::Rule("a dynamic loop cannot run yet — spawn the worker without `loop`".into()));
        }
        if let Some(target) = &body.workspace_of
            && m.worker(target).await?.is_some_and(|w| w.is_archived())
        {
            return Err(Error::Conflict("workspaceOf target is archived — restore it first".into()));
        }

        // Every worker starts from a definition: its defaults, its tool scope.
        let role = body.role.as_ref().and_then(name_of);
        let definition_name = resolve_definition_name(body.from.as_deref(), role.as_deref()).to_owned();
        let lookup = body.worktree_from.as_deref().or(body.cwd.as_deref()).map(expand_path);
        let owner = body.definition_owner_id.clone().or(body.parent_id.clone());
        let found = m.definitions.resolve(&definition_name, lookup.as_deref().map(Path::new), owner.as_deref()).await?;
        let Some(mut definition) = found else {
            return Err(Error::Validation(if definition_name == DEFAULT_WORKER_DEFINITION {
                format!(
                    "default worker definition \"{DEFAULT_WORKER_DEFINITION}\" not found — check the worker-definitions dir"
                )
            } else {
                format!("unknown worker definition: {definition_name}")
            }));
        };
        // `provider/model` names a backend profile and its model; the prefix never reaches the engine.
        let is_backend = |name: &str| config.backends.contains_key(name);
        if definition.model.as_deref().is_some_and(|m| m.contains('/')) {
            let (model, profile) =
                resolve_combined_model(definition.model.as_deref(), definition.backend_profile.as_deref(), is_backend);
            definition.model = model;
            definition.backend_profile = profile;
        }
        let (body_model, body_profile) = resolve_combined_model(body.model.as_deref(), None, is_backend);
        let defaults = apply_defaults(&definition, has);
        let inline = body.tools_allow.is_some()
            || body.tools_deny.is_some()
            || body.edit_regex.as_deref().is_some_and(|r| !r.is_empty());
        let scope = if inline {
            tool_scope(body.tools_allow.as_deref(), body.tools_deny.as_deref(), body.edit_regex.as_deref())
        } else {
            materialize_tool_scope(&definition)
        };
        let tool_scope =
            is_restrictive(&scope).then(|| serde_json::to_string(&scope)).transpose().map_err(Error::storage)?;

        // Where it works: the user's "no worktrees" setting first, then what its definition asks for.
        let isolation = resolve_spawn_isolation(
            body.cwd.clone(),
            body.worktree_from.clone(),
            body.workspace_of.is_some(),
            setting_on(&settings, "git.spawnWithoutWorktree"),
            defaults.isolation.map(|i| match i {
                WorkerIsolation::Worktree => Isolation::Worktree,
                WorkerIsolation::Cwd => Isolation::Cwd,
            }),
        );
        let mode = match body
            .permission_mode
            .as_ref()
            .and_then(name_of)
            .or(defaults.permission_mode.as_ref().and_then(name_of))
        {
            Some(mode) => Some(mode),
            None => match &body.parent_id {
                Some(parent) => Some(m.inherited_mode(parent).await?),
                None => None,
            },
        };
        if let Some(kind) = &body.backend_kind {
            engine_runs(m, kind)?;
        }
        let profile = body_profile.or(defaults.backend_profile.clone());
        if let Some(profile) = &profile {
            profile_runs(m, &config, profile)?;
        }
        let model = defaults.model.clone().or(body_model);
        let request = SpawnRequest {
            prompt,
            cwd: isolation.cwd.as_deref().map(expand_path),
            worktree_from: isolation.worktree_from.as_deref().map(expand_path),
            branch: body.branch.clone(),
            name: body.name.clone(),
            parent_id: body.parent_id.clone(),
            model: model.as_deref().map(|m| model_for(Some(m))),
            effort: defaults.effort.as_ref().and_then(name_of).or(body.effort.clone()),
            role,
            workspace_of: body.workspace_of.clone(),
            carry_uncommitted: setting_on(&settings, "git.carryUncommitted"),
            hydrate_env: config.worker.hydrate_env_files,
            collaborate: defaults.collaborate.or(body.collaborate).unwrap_or(false),
            backend_profile: profile,
            worker_definition: Some(definition.name.clone()),
            tool_scope,
            permission_mode: mode,
            // The operator's own spawn shows its prompt as their first message.
            record_prompt: body.parent_id.is_none(),
            ..SpawnRequest::default()
        };
        let isolation = if request.worktree_from.is_some() || request.workspace_of.is_some() {
            SpawnWorkerResponseIsolation::Worktree
        } else {
            SpawnWorkerResponseIsolation::Cwd
        };
        let spawned = m.sessions.spawn(request).await?;

        Ok(SpawnedWorker { id: spawned.id, boot_msg_id: spawned.boot_msg_id, isolation })
    }
}

fn worker(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SpawnWorkerRequest = req.parse()?;
            let spawned = m.spawn_worker(body).await?;
            let mut answer = json!({"id": spawned.id, "port": 0});
            if let Some(fields) = answer.as_object_mut() {
                if let Some(msg) = spawned.boot_msg_id {
                    fields.insert("bootMsgId".into(), msg.into());
                }
                fields.insert("isolation".into(), json!(spawned.isolation));
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
