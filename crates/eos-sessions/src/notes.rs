//! Notes for the model that ride with a turn: features hand them in through
//! [`SessionHooks::turn_notes`](crate::SessionHooks::turn_notes); a turn waits
//! for them only briefly, so a slow feature never holds a message up.

use eos_core::agent::NoteTurn;

use crate::service::{NOTES_WAIT_MS, Sessions};

impl Sessions {
    /// The notes for `turn` that came within [`NOTES_WAIT_MS`]; none after it.
    pub(crate) async fn notes_in_time(&self, turn: NoteTurn) -> Vec<String> {
        let worker_id = turn.worker_id.clone();
        let notes = self.0.deps.hooks.turn_notes(turn);
        tokio::select! {
            notes = notes => notes,
            () = self.0.deps.sleeper.sleep(NOTES_WAIT_MS) => {
                tracing::info!(worker_id = %worker_id, "turn notes came too late: the turn starts without them");
                Vec::new()
            }
        }
    }
}
