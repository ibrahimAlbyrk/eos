//! The date and time on the user's computer (`current_datetime`).

use std::sync::Arc;

use eos_core::os::TimeZone;
use eos_core::{BoxFuture, Clock};
use eos_domain::time::iso_from_ms;
use serde_json::{Value, json};

use crate::schema::object;
use crate::tool::{Call, Handler, Outcome, Output, Spec};

/// `+03:00`, `-05:30`: minutes east of UTC as an offset.
fn offset_label(minutes: i32) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let abs = minutes.abs();
    format!("{sign}{:02}:{:02}", abs / 60, abs % 60)
}

/// The instant with the user's wall-clock reading of it
/// (`core/src/use-cases/CurrentDateTime.ts`).
pub(crate) fn current_datetime(epoch_ms: i64, zone: &dyn TimeZone) -> Value {
    let offset_minutes = zone.offset_minutes_at(epoch_ms);
    let offset = offset_label(offset_minutes);
    // The instant moved by the offset, read as UTC, is the local wall clock.
    let local = iso_from_ms(epoch_ms + i64::from(offset_minutes) * 60_000);
    let (date, time, millis) = (&local[..10], &local[11..19], &local[20..23]);
    let name = zone.name();
    json!({
        "epochMs": epoch_ms,
        "iso": format!("{date}T{time}.{millis}{offset}"),
        "utc": iso_from_ms(epoch_ms),
        "timeZone": name,
        "utcOffsetMinutes": offset_minutes,
        "formatted": format!("{date} {time} UTC{offset} ({name})"),
    })
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
