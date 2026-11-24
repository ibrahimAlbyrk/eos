//! The kept scripts the permission gateway checks a `Workflow` call by,
//! attached once the routines feature is built, after the gateway. Until
//! then no session runs a routine's script, so every call is the policy's.

use std::sync::{OnceLock, Weak};

use eos_contracts::UnknownRecord;
use eos_core::policy::{KeptScripts, ScriptCall};
use eos_core::{BoxFuture, Error};

#[derive(Default)]
pub(crate) struct LateScripts(OnceLock<Weak<dyn KeptScripts>>);

impl LateScripts {
    pub(crate) fn attach(&self, scripts: &std::sync::Arc<dyn KeptScripts>) {
        let _ = self.0.set(std::sync::Arc::downgrade(scripts));
    }
}

impl KeptScripts for LateScripts {
    fn check<'a>(&'a self, worker_id: &'a str, input: &'a UnknownRecord) -> BoxFuture<'a, Result<ScriptCall, Error>> {
        match self.0.get().and_then(Weak::upgrade) {
            Some(scripts) => Box::pin(async move { scripts.check(worker_id, input).await }),
            None => Box::pin(std::future::ready(Ok(ScriptCall::NotOurs))),
        }
    }
}
