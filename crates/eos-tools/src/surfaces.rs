//! The surface tools of a routine run's sessions: `return_view` hands a View
//! back for a routine whose result is one, `fill_page` the data of a Page;
//! a design run's designer reads its page and proposes a design; a session
//! building an App hands it in with `app_propose`.
//! The surfaces feature ([`SurfaceTools`]) checks each and stores it as an
//! issue; the View, the data and the bindings never reach a log.

use std::sync::Arc;

use eos_core::surface::{ReturnedView, SurfaceTools};
use eos_core::{BoxFuture, Error};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{array, object, one_of, record, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

struct ReturnView(Arc<dyn SurfaceTools>);

#[derive(Deserialize)]
struct ViewArgs {
    place: String,
    view: Value,
    bindings: Option<Value>,
}

impl Handler for ReturnView {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ViewArgs { place, view, bindings } = args(input)?;
            match self.0.return_view(call.self_id, ReturnedView { place, view, bindings }).await {
                Ok(line) => Ok(Output::text(line)),
                // Every problem with its path, so one more call can fix them all.
                Err(Error::Validation(problems)) => Err(Failure(problems)),
                Err(other) => Err(other.into()),
            }
        })
    }
}

struct FillPage(Arc<dyn SurfaceTools>);

#[derive(Deserialize)]
struct FillArgs {
    data: Option<Value>,
}

impl Handler for FillPage {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let FillArgs { data } = args(input)?;
            match self.0.fill_page(call.self_id, data.unwrap_or(Value::Null)).await {
                Ok(line) => Ok(Output::text(line)),
                Err(Error::Validation(problems)) => Err(Failure(problems)),
                Err(other) => Err(other.into()),
            }
        })
    }
}

struct DesignRead(Arc<dyn SurfaceTools>);

impl Handler for DesignRead {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let read = self.0.page_design_read(call.self_id).await?;
            Ok(Output::text(serde_json::to_string_pretty(&read).unwrap_or_default()))
        })
    }
}

struct DesignPropose(Arc<dyn SurfaceTools>);

#[derive(Deserialize)]
struct ProposeArgs {
    note: String,
    #[serde(flatten)]
    design: serde_json::Map<String, Value>,
}

impl Handler for DesignPropose {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ProposeArgs { note, design } = args(input)?;
            match self.0.page_design_propose(call.self_id, Value::Object(design), note).await {
                Ok(line) => Ok(Output::text(line)),
                Err(Error::Validation(problems)) => Err(Failure(problems)),
                Err(other) => Err(other.into()),
            }
        })
    }
}

struct AppPropose(Arc<dyn SurfaceTools>);

impl Handler for AppPropose {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ProposeArgs { note, design } = args(input)?;
            match self.0.app_propose(call.self_id, Value::Object(design), note).await {
                Ok(line) => Ok(Output::text(line)),
                Err(Error::Validation(problems)) => Err(Failure(problems)),
                Err(other) => Err(other.into()),
            }
        })
    }
}

/// The designer's tools: read the page it works on, and propose a design.
pub(crate) fn designer_specs(tools: &Arc<dyn SurfaceTools>) -> Vec<Spec> {
    vec![
        Spec::new("page_design_read", object(vec![]), DesignRead(tools.clone())).always_load(),
        Spec::new(
            "page_design_propose",
            object(vec![
                ("template", string().describe("The page markup.")),
                ("style", string().describe("The page's CSS.")),
                ("contract", record().describe("The object type each run fills.")),
                ("sample", record().describe("Data that fits the contract.")),
                ("tile", record().optional().describe("What the page's tile on Home shows.")),
                ("uses", array(string()).optional().describe("The direct actions its Buttons run.")),
                ("queries", array(string()).optional().describe("The named queries its Live parts read.")),
                ("note", string().min(1).max(200).describe("One line the user reads beside the change.")),
            ]),
            DesignPropose(tools.clone()),
        )
        .always_load(),
    ]
}

pub(crate) fn specs(tools: &Arc<dyn SurfaceTools>) -> Vec<Spec> {
    vec![Spec::new(
        "return_view",
        object(vec![
            ("place", one_of(&["result", "question"]).describe("`result` for the run's answer, `question` for a choice the user makes.")),
            ("view", record().describe("The View, as the visual-answer catalog writes one: title, summary, ui, data, actions.")),
            ("bindings", record().optional().describe("For each `send` action of the view: {action, args}, the direct action it runs and its argument template.")),
        ]),
        ReturnView(tools.clone()),
    )
    .always_load(),
    Spec::new(
        "fill_page",
        object(vec![(
            "data",
            record().optional().describe("The page's data, fitting its contract; left out to read the contract and a sample."),
        )]),
        FillPage(tools.clone()),
    )
    .always_load(),
    Spec::new(
        "app_propose",
        object(vec![
            ("html", string().describe("The App: one HTML document with its script and style inline.")),
            ("manifest", record().describe("What it may call: title, summary, height?, uses, queries, files?, stateMaxBytes?")),
            ("tests", string().optional().describe("Its tests, run in Eos's probe with a fake bridge.")),
            ("note", string().min(1).max(200).describe("One line the user reads beside the change.")),
        ]),
        AppPropose(tools.clone()),
    )
    .always_load()]
}
