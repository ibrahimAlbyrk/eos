//! The surface tools of a routine run's sessions: `return_view` hands a View
//! back for a routine whose result is one, `fill_page` the data of a Page.
//! The surfaces feature ([`SurfaceTools`]) checks each and stores it as an
//! issue; the View, the data and the bindings never reach a log.

use std::sync::Arc;

use eos_core::surface::{ReturnedView, SurfaceTools};
use eos_core::{BoxFuture, Error};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{object, one_of, record};
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
    .always_load()]
}
