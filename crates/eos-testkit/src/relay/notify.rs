//! A phone that is woken in memory: [`PhoneNotify`] that records each push.

use std::sync::{Mutex, MutexGuard};

use eos_core::net::relay::{PhoneNotify, PhonePush, PushOutcome};
use eos_core::{BoxFuture, Error};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Records every push and answers as told: one phone reached at first.
#[derive(Debug)]
pub struct FakePhoneNotify {
    pushes: Mutex<Vec<PhonePush>>,
    answer: Mutex<Result<PushOutcome, Error>>,
}

impl Default for FakePhoneNotify {
    fn default() -> Self {
        Self { pushes: Mutex::default(), answer: Mutex::new(Ok(PushOutcome::Sent { devices: 1, failed: 0 })) }
    }
}

impl FakePhoneNotify {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every push asked for, in order.
    pub fn pushes(&self) -> Vec<PhonePush> {
        lock(&self.pushes).clone()
    }

    /// How a push ends from here on.
    pub fn answer(&self, answer: Result<PushOutcome, Error>) {
        *lock(&self.answer) = answer;
    }
}

impl PhoneNotify for FakePhoneNotify {
    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushOutcome, Error>> {
        lock(&self.pushes).push(push);
        let answer = lock(&self.answer).clone();
        Box::pin(std::future::ready(answer))
    }
}
