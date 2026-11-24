//! The native secret prompt as the test answers it.

use std::sync::{Mutex, MutexGuard};

use eos_core::BoxFuture;
use eos_core::shell::{SecretAsk, SecretPrompt};
use zeroize::Zeroizing;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Answers each prompt with the next scripted value (`None`: the user
/// cancelled), and cancels once none is left. Records what was asked.
#[derive(Debug, Default)]
pub struct FakeSecretPrompt {
    answers: Mutex<Vec<Option<String>>>,
    asked: Mutex<Vec<SecretAsk>>,
}

impl FakeSecretPrompt {
    pub fn new() -> Self {
        Self::default()
    }

    /// The user types `value` at the next prompt, or cancels it on `None`.
    pub fn answer(&self, value: Option<&str>) {
        locked(&self.answers).push(value.map(str::to_owned));
    }

    /// What each prompt asked, in order.
    pub fn asked(&self) -> Vec<SecretAsk> {
        locked(&self.asked).clone()
    }
}

impl SecretPrompt for FakeSecretPrompt {
    fn ask(&self, ask: SecretAsk) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        locked(&self.asked).push(ask);
        let mut answers = locked(&self.answers);
        let answer = if answers.is_empty() { None } else { answers.remove(0) };
        Box::pin(std::future::ready(answer.map(Zeroizing::new)))
    }
}
