//! The profile routes. Reads are open (the dashboard and a controlling computer
//! render the profile); every write and the CLAUDE.md import need the user's
//! window, so an agent can never rewrite who the user is.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{
    AVATAR_MAX_BYTES, AvatarExt, ClaudeMdImportResponse, UserProfile, UserProfilePreview, UserProfileUpdateRequest,
};
use eos_core::profile::{ProfileBlockInput, UserProfileBlocks};
use eos_core::prompt::{MemoryLevel, MemoryProvider, MemoryScope};
use eos_core::store::AvatarThumbnails;
use eos_domain::avatar_thumbnail::avatar_thumbnail_size;
use eos_profile::received_memory_lines;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;

use super::failed;
use crate::profile::UserProfileService;

/// What the preview and the CLAUDE.md import need beyond the profile itself.
#[derive(Clone)]
pub struct PreviewContext {
    /// Renders the block, exactly as a session's prompt gets it.
    pub blocks: Arc<dyn UserProfileBlocks>,
    /// The CLAUDE.md-style files a session receives.
    pub memory: Arc<dyn MemoryProvider>,
    /// The data folder: where a session with no project works.
    pub data_home: PathBuf,
    /// Whether the app hands memory files to backends that do not load them
    /// themselves (`config.memory.enabled`), asked at each preview.
    pub memory_injected: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The memory search tool's name, for the "N more" hint.
    pub search_tool_name: String,
}

impl std::fmt::Debug for PreviewContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewContext").field("data_home", &self.data_home).finish_non_exhaustive()
    }
}

#[derive(Serialize)]
struct ProfileBody<'a> {
    profile: &'a UserProfile,
}

fn profile(profile: &UserProfile) -> Response {
    Response::json(200, &ProfileBody { profile })
}

fn avatar_type(ext: AvatarExt) -> &'static str {
    match ext {
        AvatarExt::Png => "image/png",
        AvatarExt::Jpeg => "image/jpeg",
        AvatarExt::Webp => "image/webp",
    }
}

impl PreviewContext {
    /// What a session of `kind` in `project` would get. No project still
    /// loads the user-level CLAUDE.md (every session gets it), so the preview
    /// drops the same lines a real session does.
    fn preview(&self, kind: &str, project: Option<&str>) -> UserProfilePreview {
        let scope = match project {
            Some(project) => MemoryScope { cwd: project.as_ref(), repo_root: None },
            None => MemoryScope { cwd: &self.data_home, repo_root: Some(&self.data_home) },
        };
        let known_lines = received_memory_lines(&self.memory.load(scope), kind, (self.memory_injected)());
        let block = self.blocks.block(&ProfileBlockInput {
            kind,
            project,
            known_lines: &known_lines,
            search_tool_name: Some(&self.search_tool_name),
        });
        UserProfilePreview {
            text: block.text,
            tokens: block.tokens,
            budget_tokens: block.budget_tokens,
            included_memory_ids: block.included_ids,
            overflow: i64::try_from(block.overflow).unwrap_or(i64::MAX),
            withheld: block.withheld,
        }
    }

    /// The user-level CLAUDE.md, read-only, for "Import from CLAUDE.md".
    fn claude_md(&self) -> ClaudeMdImportResponse {
        let scope = MemoryScope { cwd: &self.data_home, repo_root: Some(&self.data_home) };
        let doc =
            self.memory.load(scope).docs.into_iter().find(|d| d.level == MemoryLevel::User && d.source_id == "claude");
        match doc {
            Some(doc) => {
                ClaudeMdImportResponse { path: Some(doc.path.to_string_lossy().into_owned()), text: doc.content }
            }
            None => ClaudeMdImportResponse { path: None, text: String::new() },
        }
    }
}

pub(crate) fn all(
    service: &Arc<UserProfileService>,
    context: &Arc<PreviewContext>,
    thumbnails: Option<Arc<dyn AvatarThumbnails>>,
) -> Vec<RouteDef> {
    let read = {
        let service = service.clone();
        RouteDef::get("/api/profile", move |_req: Request| {
            let service = service.clone();
            async move { Ok(profile(&service.get())) }
        })
    };
    let save = {
        let service = service.clone();
        RouteDef::put("/api/profile", move |req: Request| {
            let service = service.clone();
            async move {
                let body: UserProfileUpdateRequest = req.parse()?;
                service.update(&body.patch, body.base_rev).map_or_else(failed, |saved| Ok(profile(&saved)))
            }
        })
    };
    // `?kind=<backend kind>` (default claude) `&project=<folder>`.
    let preview = {
        let context = context.clone();
        RouteDef::get("/api/profile/preview", move |req: Request| {
            let context = context.clone();
            async move {
                let query = req.query();
                let kind = query.get("kind").filter(|kind| !kind.is_empty());
                let project = query.get("project").filter(|project| !project.is_empty());
                Ok(Response::json(200, &context.preview(kind.as_deref().unwrap_or("claude"), project.as_deref())))
            }
        })
    };
    // The client busts the cache with `?v=<profile rev>`. `?size=<device pixels>` asks for
    // a small copy, where this computer can make one.
    let avatar = {
        let service = service.clone();
        RouteDef::get("/api/profile/avatar", move |req: Request| {
            let (service, thumbnails) = (service.clone(), thumbnails.clone());
            let size = req.query().get("size").and_then(|s| s.parse::<u32>().ok()).filter(|s| *s > 0);
            async move {
                let avatar = match (size, thumbnails) {
                    (Some(size), Some(thumbnails)) => {
                        let size = avatar_thumbnail_size(size);
                        tokio::task::spawn_blocking(move || thumbnails.thumbnail(size))
                            .await
                            .map_err(|e| ApiError::Internal(e.to_string()))??
                    }
                    _ => service.avatar()?,
                };
                let Some(avatar) = avatar else {
                    return Err(ApiError::NotFound("no avatar".into()));
                };
                Ok(Response::bytes(200, avatar_type(avatar.ext), avatar.bytes)
                    .header("cache-control", "public, max-age=86400"))
            }
        })
    };
    // Raw image bytes; the type is read from them, not from what the request declares.
    let set_avatar = {
        let service = service.clone();
        RouteDef::put("/api/profile/avatar", move |req: Request| {
            let service = service.clone();
            async move {
                let saved = service.set_avatar(&req.body)?;
                Ok(profile(&saved))
            }
        })
        .max_body(usize::try_from(AVATAR_MAX_BYTES).unwrap_or(usize::MAX))
    };
    let clear_avatar = {
        let service = service.clone();
        RouteDef::delete("/api/profile/avatar", move |_req: Request| {
            let service = service.clone();
            async move {
                let saved = service.clear_avatar()?;
                Ok(profile(&saved))
            }
        })
    };
    let import = {
        let context = context.clone();
        RouteDef::get("/api/profile/import/claude-md", move |_req: Request| {
            let context = context.clone();
            async move { Ok(Response::json(200, &context.claude_md())) }
        })
    };
    vec![
        read.access(Access::open()),
        save.access(Access::ui_token()),
        preview.access(Access::open()),
        avatar.access(Access::open()),
        set_avatar.access(Access::ui_token()),
        clear_avatar.access(Access::ui_token()),
        import.access(Access::ui_token()),
    ]
}
