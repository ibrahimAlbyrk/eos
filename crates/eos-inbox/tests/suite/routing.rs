//! A routine run's asks go to Needs you; a chat's to the banner.

use eos_core::inbox::{AskRoute, AskRouting};
use eos_inbox::RunAsks;

use crate::rig::Rig;

#[test]
fn a_run_workers_asks_go_to_needs_you_and_a_chats_to_the_banner() {
    let rig = Rig::new();
    rig.temp.exec(
        "INSERT INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, created_at, \
         updated_at) VALUES ('rn-1', 'rt-1', 'rv-1', 'standing', 'hand', '{}', 'running', 0, 'd', 1, 1); \
         INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
         VALUES ('w-run', 'rt-1', 'rn-1', 'solo', 1), ('w-architect', 'rt-1', NULL, 'architect', 1);",
    );
    let routes = rig
        .temp
        .store
        .read_blocking(|tx| {
            Ok([RunAsks.route(tx, "w-run"), RunAsks.route(tx, "w-architect"), RunAsks.route(tx, "w-chat")])
        })
        .expect("reads");
    assert_eq!(routes, [AskRoute::Inbox, AskRoute::Banner, AskRoute::Banner]);
}
