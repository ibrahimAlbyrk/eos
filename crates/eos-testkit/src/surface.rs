//! Surfaces as routines see them: every call recorded.

use std::sync::Mutex;

use eos_core::surface::SurfaceAuthoring;
use eos_core::{BoxFuture, Error};

/// What routines asked of surfaces, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceCall {
    Create { routine_id: String, version_id: String, makes: String },
    Keep(String),
    Archive(String),
    Restore(String),
}

#[derive(Debug, Default)]
pub struct FakeSurfaceAuthoring {
    calls: Mutex<Vec<SurfaceCall>>,
}

impl FakeSurfaceAuthoring {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<SurfaceCall> {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn record(&self, call: SurfaceCall) -> BoxFuture<'_, Result<(), Error>> {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(call);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl SurfaceAuthoring for FakeSurfaceAuthoring {
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Create {
            routine_id: routine_id.to_owned(),
            version_id: version_id.to_owned(),
            makes: makes.to_owned(),
        })
    }

    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Keep(routine_id.to_owned()))
    }

    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Archive(routine_id.to_owned()))
    }

    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Restore(routine_id.to_owned()))
    }
}

/// Needs you's items for returned Views: each card opened gets the id
/// `ny-view-<n>`; a question View's run hears `answer` at once. Every card and
/// every answer recorded.
#[derive(Debug, Default)]
pub struct FakeViewCards {
    opened: Mutex<Vec<eos_core::surface::ViewCard>>,
    answered: Mutex<Vec<(String, String)>>,
    answer: Mutex<String>,
}

impl FakeViewCards {
    pub fn new() -> Self {
        Self::default()
    }

    /// What a question View's run hears.
    pub fn hearing(self, answer: &str) -> Self {
        *self.answer.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = answer.to_owned();
        self
    }

    pub fn opened(&self) -> Vec<eos_core::surface::ViewCard> {
        self.opened.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Each answer, as (item id, what was pressed).
    pub fn answered(&self) -> Vec<(String, String)> {
        self.answered.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl eos_core::surface::ViewCards for FakeViewCards {
    fn open_in(
        &self,
        _tx: &dyn eos_core::store::Tx,
        _out: &mut eos_core::store::Outbox,
        _now: i64,
        card: &eos_core::surface::ViewCard,
    ) -> Result<String, Error> {
        let mut opened = self.opened.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        opened.push(card.clone());
        Ok(format!("ny-view-{}", opened.len()))
    }

    fn heard<'a>(&'a self, _item_id: &'a str) -> BoxFuture<'a, String> {
        let answer = self.answer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Box::pin(std::future::ready(answer))
    }

    fn answer<'a>(&'a self, item_id: &'a str, pressed: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let pair = (item_id.to_owned(), pressed.to_owned());
        self.answered.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(pair);
        Box::pin(std::future::ready(Ok(())))
    }
}
