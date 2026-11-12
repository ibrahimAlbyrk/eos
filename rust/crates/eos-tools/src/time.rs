//! The date and time on the user's computer (`current_datetime`).

use std::sync::Arc;

use eos_core::os::TimeZone;
use eos_core::{BoxFuture, Clock};
use serde_json::{Value, json};

use crate::schema::object;
use crate::tool::{Call, Handler, Outcome, Output, Spec};

/// The instant with the user's wall-clock reading of it.
pub(crate) fn current_datetime(epoch_ms: i64, zone: &dyn TimeZone) -> Value {
    json!(eos_domain::time::current_datetime(epoch_ms, zone.offset_minutes_at(epoch_ms), &zone.name()))
}

struct CurrentDatetime {
    clock: Arc<dyn Clock>,
    zone: Arc<dyn TimeZone>,
}

impl Handler for CurrentDatetime {
    fn run<'a>(&'a self, _call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move { Ok(Output::Json(current_datetime(self.clock.now_ms(), self.zone.as_ref()))) })
    }
}

pub(crate) fn spec(clock: &Arc<dyn Clock>, zone: &Arc<dyn TimeZone>) -> Spec {
    Spec::new("current_datetime", object(vec![]), CurrentDatetime { clock: clock.clone(), zone: zone.clone() })
}
