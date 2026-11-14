//! Terminals.
//!
//! - **Sessions**: the embedded terminal's tabs — a login shell in a PTY each,
//!   its output on the bus (`pty:data`, only to the tabs that show it), its
//!   screen mirrored for whoever attaches later.
//! - **Claude panes**: a session that runs the user's own Claude Code, with
//!   hooks that report its conversation id and open dialogs; its conversation
//!   read from Claude's transcript, and prompts and answers typed into its TUI.
//! - **`!` commands**: one-shot command lines from the composer, each a job.
//!
//! How output reaches a client: the event stream (`GET /stream`, with the
//! tab's terminals in `ptys=`), input by `POST /pty/:id/input`. There is no
//! socket of its own.

mod conversation;
mod deliver;
mod keys;
mod launch;
mod ordered_input;
mod osc;
mod routes;
mod runs;
mod sessions;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

use std::sync::Arc;

use eos_core::store::Store;
use eos_core::terminal::ClaudeTranscripts;
use eos_runtime::bus::TopicDecl;
use eos_runtime::module::Module;
use eos_runtime::router::{BoxFuture, RouteDef};

use conversation::Conversations;
use runs::Runs;
pub use runs::{RunDeps, TERMINAL_CHUNK, TERMINAL_DONE, TERMINAL_START, TerminalChunk, TerminalDone, TerminalStart};
use sessions::Sessions;
pub use sessions::{
    PTY_CONVERSATION, PTY_DATA, PTY_EXIT, PTY_SESSION, PtyConversationChange, PtyData, PtyExit, SessionDeps,
};

pub struct TerminalsModule {
    sessions: Sessions,
    conversations: Conversations,
    runs: Runs,
    store: Arc<dyn Store>,
}

impl std::fmt::Debug for TerminalsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalsModule").finish_non_exhaustive()
    }
}

impl TerminalsModule {
    pub fn new(sessions: SessionDeps, transcripts: Arc<dyn ClaudeTranscripts>, runs: RunDeps) -> Self {
        let bus = sessions.bus.clone();
        let store = runs.store.clone();
        let sessions = Sessions::new(sessions);
        let conversations = Conversations::new(bus, sessions.clone(), transcripts);
        Self { sessions, conversations, runs: Runs::new(runs), store }
    }
}

impl Module for TerminalsModule {
    fn id(&self) -> &'static str {
        "terminals"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = routes::pty(self.sessions.clone(), self.conversations.clone());
        routes.extend(routes::commands(self.runs.clone(), self.store.clone()));
        routes
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![
            PTY_SESSION.decl(),
            PTY_EXIT.decl(),
            PTY_DATA.decl(),
            PTY_CONVERSATION.decl(),
            TERMINAL_START.decl(),
            TERMINAL_CHUNK.decl(),
            TERMINAL_DONE.decl(),
        ]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec!["shell"]
    }

    /// No shell, watch or command outlives the app.
    fn stop(&self) -> BoxFuture<'_, ()> {
        self.conversations.stop();
        self.runs.shutdown();
        self.sessions.shutdown();
        Box::pin(std::future::ready(()))
    }
}
