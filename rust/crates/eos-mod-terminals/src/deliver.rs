//! Submitting a prompt to a pane's Claude (`manager/services/pty/deliverPrompt.ts`).

use std::time::Duration;

use crate::conversation::Conversations;
use crate::keys::prompt_steps;
use crate::sessions::Sessions;

/// How long an idle Claude gets to record a submitted prompt before Enter is retried.
const ACK: Duration = Duration::from_millis(3000);
const POLL: Duration = Duration::from_millis(250);

/// The id of the newest prompt in the conversation, `0` when there is none.
async fn last_prompt(conversations: &Conversations, pty_id: &str) -> (i64, bool) {
    let conversation = conversations.get(pty_id).await;
    let view = conversation.map(|c| c.view).unwrap_or_default();
    let id = view.rows.iter().rev().find(|r| r.r#type == "user_message").map_or(0, |r| r.id);
    (id, view.running)
}

/// Pastes `text` into the pane's composer and submits it. Right after launch
/// the TUI can drop the Enter that follows the paste, leaving the prompt
/// sitting in the composer — so when Claude was idle, the prompt must reach
/// the transcript, else Enter goes once more. (Mid-turn, Claude queues a
/// prompt and records it only after the turn, so there is nothing to check.)
/// `false`: the session is gone.
pub(crate) async fn deliver_prompt(
    sessions: &Sessions,
    conversations: &Conversations,
    pty_id: &str,
    text: &str,
) -> bool {
    let known = conversations.get(pty_id).await.is_some();
    let (before, running) = last_prompt(conversations, pty_id).await;
    if !sessions.send_steps(pty_id, &prompt_steps(text)).await {
        return false;
    }
    if !known || running {
        return true;
    }
    let mut waited = Duration::ZERO;
    while waited < ACK {
        tokio::time::sleep(POLL).await;
        waited += POLL;
        if last_prompt(conversations, pty_id).await.0 != before {
            return true;
        }
    }
    sessions.send_steps(pty_id, &["\r".to_owned()]).await
}
