//! No stream shows the wrappers that tell a model who is speaking.

use bytes::Bytes;
use eos_runtime::stream::DisplayFilter;

/// Runs every stream payload through the domain's display rule. Nearly all
/// payloads pass untouched (and uncopied).
pub(crate) struct StripSenderTags;

impl DisplayFilter for StripSenderTags {
    fn filter(&self, _topic: &str, payload: &Bytes) -> Option<Bytes> {
        let text = std::str::from_utf8(payload).ok()?;
        eos_domain::display::sanitize_payload(text).map(Bytes::from)
    }
}
