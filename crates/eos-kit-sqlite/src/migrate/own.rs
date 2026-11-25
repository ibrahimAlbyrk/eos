// This app's own migrations, run after today's TypeScript ones (`embedded.rs`, generated).
// Each only adds a table or an index, or a trigger on a table this app added: the previous
// app version, and today's TypeScript app, still open a file that ran them (they leave ids they do not know alone). Rows of the
// TypeScript app's tables change only back to values it wrote. Append only.

use super::Migration;

pub(super) const OWN: &[Migration] = &[
    // One type of one conversation (the prompt markers, the attachments) without reading the whole log.
    embed!("065_idx_events_worker_type_id"),
    // The facts a chat's subagent and artifact lists are derived from, and how far each log was read in.
    embed!("066_conversation_list_facts"),
    // The session this app continues a chat in, apart from the one the TypeScript app resumes it by.
    embed!("067_engine_sessions"),
    // The emoji the user and the agent leave on each other's messages, and what the agent was told of them.
    embed!("068_message_reactions"),
    // Routines: their blueprint versions, drafts, sessions, spend by day and suggestions.
    embed!("069_routines"),
    // Runs of routines, their timelines and their results.
    embed!("070_runs"),
    // Signals: their sources, what became of each for each routine, schedules and runners.
    embed!("071_signals"),
    // Needs you: items, deliveries, edits, outcomes, freedom offers and the stop switch.
    embed!("072_inbox"),
    // Capabilities: what is installed and how it stands, every version of each package, and calls.
    embed!("073_capabilities"),
    // Memory: notes, hooks, links, vectors, evidence, versions and counters.
    embed!("074_mem_core"),
    // Memory's journal: moments, cursors, uses, stated rules, forgotten notes, replays, switches.
    embed!("075_mem_journal"),
    // Search of memory notes by words.
    embed!("076_mem_fts"),
    // The one-offs made of each kind of task, kept past the one-offs themselves.
    embed!("077_routine_once_asks"),
    // Surfaces: their designs, issues, edits, saved state, pins and the record of each action run from one.
    embed!("078_surfaces"),
    // Which signal source each hook of the relay's inbox wakes.
    embed!("079_signal_hooks"),
    // Summaries of runs the user's other computers finished, as sync brought them.
    embed!("080_synced_runs"),
];
