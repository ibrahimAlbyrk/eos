// This app's own migrations, run after today's TypeScript ones (`embedded.rs`, generated).
// Each only adds a table or an index: the previous app version, and today's TypeScript app,
// still open a file that ran them (they leave ids they do not know alone). Rows of the
// TypeScript app's tables change only back to values it wrote. Append only.

use super::Migration;

pub(super) const OWN: &[Migration] = &[
    // One type of one conversation (the prompt markers, the attachments) without reading the whole log.
    embed!("065_idx_events_worker_type_id"),
    // The facts a chat's subagent and artifact lists are derived from, and how far each log was read in.
    embed!("066_conversation_list_facts"),
    // The session this app continues a chat in, apart from the one the TypeScript app resumes it by.
    embed!("067_engine_sessions"),
];
