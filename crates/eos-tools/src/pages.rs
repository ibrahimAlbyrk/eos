//! Pages: the markdown notes agents share with the user (`list_pages`,
//! `read_page`, `create_page`, `append_to_page`, `edit_page`, `set_page_task`).

use std::sync::Arc;

use eos_contracts::builtin_plugins::ids::PAGES;
use eos_contracts::{
    PageAuthor, PageAuthorKind, PageEditRequest, PageEditRequestAppend, PageEditRequestReplace, PageEditRequestSetTask,
};
use eos_core::BoxFuture;
use eos_core::pages::PageEditor;
use eos_domain::time::iso_from_ms;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::schema::{Schema, boolean, object, string};
use crate::tool::{Call, Handler, Outcome, Output, Spec, args};

/// A page title's greatest length (`PAGE_TITLE_MAX`).
const PAGE_TITLE_MAX: u64 = 200;

fn page_id() -> Schema {
    string().describe("Page id, e.g. 'pg-3f9a1c2b7d10' (from list_pages or create_page)")
}

/// Who edited a page, as the reading agent is told.
fn author_label(by: &PageAuthor, self_id: &str) -> String {
    if by.kind == PageAuthorKind::User {
        return "the user".to_owned();
    }
    if by.agent_id.as_deref() == Some(self_id) {
        return "you".to_owned();
    }
    match by.name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => format!("agent {name}"),
        None => format!("agent {}", by.agent_id.as_deref().unwrap_or("unknown")),
    }
}

/// A page's own title, or the list's word for a page without one.
fn title_of(title: &str) -> &str {
    if title.is_empty() { "Untitled" } else { title }
}

fn iso(ms: eos_contracts::Num) -> String {
    #[allow(clippy::cast_possible_truncation)]
    iso_from_ms(ms.as_f64() as i64)
}

struct ListPages(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct ListArgs {
    query: Option<String>,
    all: bool,
}

impl Handler for ListPages {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ListArgs { query, all } = args(input)?;
            let query = query.as_deref().filter(|q| !q.is_empty());
            let pages = self.0.list(call.self_id, query, all).await?;
            let pages: Vec<Value> = pages
                .iter()
                .map(|p| {
                    let mut row = Map::new();
                    row.insert("id".into(), json!(p.id));
                    row.insert("title".into(), title_of(&p.title).into());
                    row.insert("excerpt".into(), p.excerpt.clone().into());
                    row.insert("openTasks".into(), p.tasks.open.into());
                    row.insert("doneTasks".into(), p.tasks.done.into());
                    row.insert("updatedAt".into(), iso(p.updated_at).into());
                    row.insert("updatedBy".into(), author_label(&p.updated_by, call.self_id).into());
                    if all {
                        row.insert("project".into(), json!(p.project));
                    }
                    Value::Object(row)
                })
                .collect();
            Ok(Output::json(&json!({ "pages": pages })))
        })
    }
}

struct ReadPage(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

impl Handler for ReadPage {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let IdArgs { id } = args(input)?;
            let page = self.0.read(&id).await?;
            let edited = format!("{} by {}", iso(page.updated_at), author_label(&page.updated_by, call.self_id));
            Ok(Output::text(format!(
                "# {}\n(page {} · rev {} · last edited {edited})\n\n{}",
                title_of(&page.title),
                page.id.0,
                page.rev,
                page.body
            )))
        })
    }
}

struct CreatePage(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct CreateArgs {
    title: String,
    body: String,
}

impl Handler for CreatePage {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let CreateArgs { title, body } = args(input)?;
            let page = self.0.create(call.self_id, &title, &body).await?;
            Ok(Output::json(&json!({"id": page.id, "title": page.title, "rev": page.rev})))
        })
    }
}

/// An edit answers with the new revision, not the whole page.
async fn edit(pages: &dyn PageEditor, call: Call<'_>, id: &str, edit: PageEditRequest) -> Outcome {
    let page = pages.edit(call.self_id, id, &edit).await?;
    Ok(Output::json(&json!({"id": page.id, "rev": page.rev})))
}

struct AppendToPage(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct AppendArgs {
    id: String,
    text: String,
    under_heading: Option<String>,
}

impl Handler for AppendToPage {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let AppendArgs { id, text, under_heading } = args(input)?;
            let heading = under_heading.filter(|h| !h.is_empty());
            edit(self.0.as_ref(), call, &id, PageEditRequest::Append(PageEditRequestAppend { text, heading })).await
        })
    }
}

struct EditPage(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct ReplaceArgs {
    id: String,
    old_text: String,
    new_text: String,
}

impl Handler for EditPage {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ReplaceArgs { id, old_text, new_text } = args(input)?;
            edit(self.0.as_ref(), call, &id, PageEditRequest::Replace(PageEditRequestReplace { old_text, new_text }))
                .await
        })
    }
}

struct SetPageTask(Arc<dyn PageEditor>);

#[derive(Deserialize)]
struct TaskArgs {
    id: String,
    task: String,
    done: bool,
}

impl Handler for SetPageTask {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let TaskArgs { id, task, done } = args(input)?;
            edit(self.0.as_ref(), call, &id, PageEditRequest::SetTask(PageEditRequestSetTask { task, done })).await
        })
    }
}

pub(crate) fn specs(pages: &Arc<dyn PageEditor>) -> Vec<Spec> {
    let plugin = PAGES;
    vec![
        Spec::new(
            "list_pages",
            object(vec![
                (
                    "query",
                    string().optional().describe("Only pages whose title or text contains this (case-insensitive)."),
                ),
                (
                    "all",
                    boolean()
                        .default(json!(false))
                        .describe("true = pages from every project, not just the one this chat works in."),
                ),
            ]),
            ListPages(pages.clone()),
        )
        .plugin(plugin),
        Spec::new("read_page", object(vec![("id", page_id())]), ReadPage(pages.clone())).plugin(plugin),
        Spec::new(
            "create_page",
            object(vec![
                (
                    "title",
                    string()
                        .min(1)
                        .max(PAGE_TITLE_MAX)
                        .describe("Short title the user will recognise in the page list."),
                ),
                ("body", string().default(json!("")).describe("Markdown content. Checklists use '- [ ] item'.")),
            ]),
            CreatePage(pages.clone()),
        )
        .plugin(plugin),
        Spec::new(
            "append_to_page",
            object(vec![
                ("id", page_id()),
                ("text", string().min(1).describe("Markdown to add. Checklist items use '- [ ] item'.")),
                (
                    "under_heading",
                    string().optional().describe(
                        "Add at the end of this heading's section (matched by text, any level); the heading is created at the end of the page when missing. Omit to add at the end of the page.",
                    ),
                ),
            ]),
            AppendToPage(pages.clone()),
        )
        .plugin(plugin),
        Spec::new(
            "edit_page",
            object(vec![
                ("id", page_id()),
                (
                    "old_text",
                    string()
                        .min(1)
                        .describe("Exact passage to replace, copied from read_page. Must occur exactly once."),
                ),
                ("new_text", string().describe("Replacement markdown. Empty string deletes the passage.")),
            ]),
            EditPage(pages.clone()),
        )
        .plugin(plugin),
        Spec::new(
            "set_page_task",
            object(vec![
                ("id", page_id()),
                (
                    "task",
                    string()
                        .min(1)
                        .describe("The checklist item's text (or a part of it that matches only that item)."),
                ),
                ("done", boolean().default(json!(true)).describe("true ticks the item, false unticks it.")),
            ]),
            SetPageTask(pages.clone()),
        )
        .plugin(plugin),
    ]
}
