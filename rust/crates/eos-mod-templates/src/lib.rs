//! The user's prompt templates over the wire (`manager/routes/templates.ts`).
//!
//! | Route | |
//! |---|---|
//! | `GET /api/templates` | every template, by name |
//! | `POST /api/templates` | creates one; 409 when the name is taken |
//! | `PUT /api/templates/{name}` | replaces one; 404 when there is none |
//! | `DELETE /api/templates/{name}` | moves it to the templates' trash |

use std::sync::Arc;

use eos_contracts::{
    Template, TemplateCreateRequest, TemplateListResponse, TemplateMutationResponse, TemplateName,
    TemplateUpdateRequest,
};
use eos_core::store::TemplateStore;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use serde_json::Value;

pub struct TemplatesModule {
    templates: Arc<dyn TemplateStore>,
}

impl std::fmt::Debug for TemplatesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TemplatesModule").finish_non_exhaustive()
    }
}

impl TemplatesModule {
    pub fn new(templates: Arc<dyn TemplateStore>) -> Self {
        Self { templates }
    }
}

const OK: TemplateMutationResponse = TemplateMutationResponse { ok: true };

/// The `{name}` of the path, checked as a template name.
fn name_of(req: &Request) -> Result<String, ApiError> {
    let name = req.param("name").unwrap_or_default();
    let checked: TemplateName = eos_contracts::validate::parse(&Value::String(name.to_owned()))?;
    Ok(checked.0)
}

fn not_found(name: &str) -> ApiError {
    ApiError::NotFound(format!("template \"{name}\" not found"))
}

/// A file store's failure is this route's 500, with the cause.
fn failed(e: eos_core::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

impl Module for TemplatesModule {
    fn id(&self) -> &'static str {
        "templates"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let templates = self.templates.clone();
        let list =
            RouteDef::get("/api/templates", move |_req: Request| {
                let templates = templates.clone();
                async move {
                    Ok(Response::json(200, &TemplateListResponse { templates: templates.list().map_err(failed)? }))
                }
            })
            .access(Access::open().phone(Tier::Read));

        let templates = self.templates.clone();
        let create = RouteDef::post("/api/templates", move |req: Request| {
            let templates = templates.clone();
            async move {
                let body: TemplateCreateRequest = req.parse()?;
                if templates.exists(&body.name.0).map_err(failed)? {
                    return Err(ApiError::Conflict(format!("template \"{}\" already exists", body.name.0)));
                }
                let template = Template {
                    name: body.name,
                    description: body.description,
                    content: body.content,
                    attachments: body.attachments,
                };
                templates.write(&template).map_err(failed)?;
                Ok(Response::json(200, &OK))
            }
        })
        .access(Access::open().phone(Tier::High));

        let templates = self.templates.clone();
        let update = RouteDef::put("/api/templates/{name}", move |req: Request| {
            let templates = templates.clone();
            async move {
                let name = name_of(&req)?;
                let body: TemplateUpdateRequest = req.parse()?;
                if !templates.exists(&name).map_err(failed)? {
                    return Err(not_found(&name));
                }
                let template = Template {
                    name: TemplateName(name),
                    description: body.description,
                    content: body.content,
                    attachments: body.attachments,
                };
                templates.write(&template).map_err(failed)?;
                Ok(Response::json(200, &OK))
            }
        })
        .access(Access::open().phone(Tier::High));

        let templates = self.templates.clone();
        let delete = RouteDef::delete("/api/templates/{name}", move |req: Request| {
            let templates = templates.clone();
            async move {
                let name = name_of(&req)?;
                if !templates.delete(&name).map_err(failed)? {
                    return Err(not_found(&name));
                }
                Ok(Response::json(200, &OK))
            }
        })
        .access(Access::open().phone(Tier::High));

        vec![list, create, update, delete]
    }
}
