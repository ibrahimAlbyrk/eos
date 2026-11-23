//! The Mail app in memory, behind `eos_mail_app::Script`: an inbox of
//! messages, accounts, a switch for macOS refusing Apple Events (-1743) and
//! the mails sent. Answers follow what the capability's JXA programs print;
//! nothing runs `osascript`.

use std::sync::{Arc, Mutex};

use eos_core::BoxFuture;
use eos_core::capability::BuiltinCapability;
use eos_mail_app::{MailApp, Parts, Program, Script, ScriptError};

use crate::{FakeClock, FakeSleeper};
use serde_json::{Value, json};

/// One mail Eos sent: who it went to and what it said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Default)]
struct State {
    accounts: i64,
    denied: bool,
    /// As the RECENT program prints them, with `body` and `to` for READ.
    inbox: Vec<Value>,
    sent: Vec<SentMail>,
    programs: Vec<Program>,
}

#[derive(Clone, Default)]
pub struct FakeMail {
    state: Arc<Mutex<State>>,
}

impl std::fmt::Debug for FakeMail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeMail").finish_non_exhaustive()
    }
}

impl FakeMail {
    /// Mail with one account and an empty inbox.
    pub fn new() -> Self {
        let mail = Self::default();
        mail.lock().accounts = 1;
        mail
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// macOS refuses every Apple Event: the user has not allowed Eos.
    pub fn denying(self) -> Self {
        self.lock().denied = true;
        self
    }

    pub fn with_accounts(self, accounts: i64) -> Self {
        self.lock().accounts = accounts;
        self
    }

    /// A mail reaches the inbox.
    pub fn receive(&self, message_id: &str, from: &str, subject: &str, body: &str, received_at: i64) {
        self.lock().inbox.push(json!({
            "messageId": message_id, "subject": subject, "from": from, "receivedAt": received_at, "read": false,
            "to": ["me@example.com"], "body": body,
        }));
    }

    pub fn sent(&self) -> Vec<SentMail> {
        self.lock().sent.clone()
    }

    /// The real mail built-in, driving this fake: for a crate below the
    /// adapters that needs a mail capability in its tests.
    pub fn builtin(&self, now: i64) -> Arc<dyn BuiltinCapability> {
        Arc::new(MailApp::new(Parts {
            script: Arc::new(self.clone()),
            clock: Arc::new(FakeClock::at(now)),
            sleeper: Arc::new(FakeSleeper::default()),
        }))
    }

    /// Every program run, in order.
    pub fn programs(&self) -> Vec<Program> {
        self.lock().programs.clone()
    }

    fn answer(&self, program: Program, input: &Value) -> Result<Value, ScriptError> {
        let mut state = self.lock();
        state.programs.push(program);
        if state.denied {
            return Err(ScriptError::Denied);
        }
        match program {
            Program::Check => Ok(json!({ "accounts": state.accounts })),
            Program::Recent => {
                let since = input["since"].as_i64().unwrap_or(0);
                let limit = usize::try_from(input["limit"].as_i64().unwrap_or(20)).unwrap_or(0);
                let mut messages: Vec<Value> = state
                    .inbox
                    .iter()
                    .filter(|message| message["receivedAt"].as_i64().unwrap_or(0) > since)
                    .map(|message| {
                        let mut summary = message.clone();
                        if let Some(fields) = summary.as_object_mut() {
                            fields.remove("body");
                            fields.remove("to");
                        }
                        summary
                    })
                    .collect();
                messages.sort_by_key(|message| std::cmp::Reverse(message["receivedAt"].as_i64()));
                messages.truncate(limit);
                Ok(json!({ "messages": messages }))
            }
            Program::Read => {
                let found = state.inbox.iter().find(|message| message["messageId"] == input["messageId"]);
                Ok(found.map_or_else(
                    || json!({ "found": false }),
                    |message| {
                        let mut read = message.clone();
                        read["found"] = json!(true);
                        read
                    },
                ))
            }
            Program::Send => {
                let text = |field: &str| input[field].as_str().unwrap_or_default().to_owned();
                state.sent.push(SentMail { to: text("to"), subject: text("subject"), body: text("body") });
                Ok(json!({ "sent": true }))
            }
        }
    }
}

impl Script for FakeMail {
    fn run(&self, program: Program, input: Value) -> BoxFuture<'_, Result<Value, ScriptError>> {
        Box::pin(std::future::ready(self.answer(program, &input)))
    }
}
