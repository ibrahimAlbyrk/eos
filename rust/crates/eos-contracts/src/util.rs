//! Port of `contracts/src/util.ts`.

pub const WORKER_EXIT_SUCCESS: i32 = 0;
pub const WORKER_EXIT_GRACEFUL_SHUTDOWN: i32 = 129;
pub const WORKER_EXIT_KILLED: i32 = 143;
pub const WORKER_EXIT_INTERRUPTED: i32 = 130;

pub fn is_worker_success_exit(code: i32) -> bool {
    code == WORKER_EXIT_SUCCESS || code == WORKER_EXIT_GRACEFUL_SHUTDOWN
}
