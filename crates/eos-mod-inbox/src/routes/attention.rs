//! `GET`/`PUT /api/settings/attention` (03 §4.7): quiet hours, digest times
//! and which items may interrupt, kept in `config.json`'s `attention`
//! section, which only this route writes. Both answer the settings as they
//! stand.

use std::sync::Arc;

use eos_contracts::AttentionSettings;
use eos_core::Error;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::Shared;

pub(super) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let at = shared.clone();
    let read = RouteDef::get("/api/settings/attention", move |_: Request| {
        let at = at.clone();
        async move { Ok::<_, ApiError>(Response::json(200, &at.config.current().attention)) }
    });
    let at = shared.clone();
    let write = RouteDef::put("/api/settings/attention", move |req: Request| {
        let at = at.clone();
        async move {
            let settings: AttentionSettings = req.parse()?;
            let section = match serde_json::to_value(&settings) {
                Ok(serde_json::Value::Object(section)) => section,
                _ => return Err(Error::storage("the attention settings could not be written").into()),
            };
            let config = at.config.clone();
            let saved = tokio::task::spawn_blocking(move || config.patch("attention", section))
                .await
                .map_err(|error| Error::storage(error.to_string()))??;
            tracing::info!(
                quiet = settings.quiet_on,
                digests = settings.digests.len(),
                "the attention settings changed"
            );
            at.attention_changed.notify_one();
            Ok(Response::json(200, &saved.attention))
        }
    });
    vec![read.access(Access::open()), write.access(Access::ui_token())]
}
