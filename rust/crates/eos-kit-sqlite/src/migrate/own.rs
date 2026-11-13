// This app's own migrations, run after today's TypeScript ones (`embedded.rs`, generated).
// Each only adds a table or an index: the previous app version, and today's TypeScript app,
// still open a file that ran them (they leave ids they do not know alone). Append only.

use super::Migration;

pub(super) const OWN: &[Migration] = &[
    // One type of one conversation (the prompt markers, the attachments) without reading the whole log.
    embed!("065_idx_events_worker_type_id"),
];
