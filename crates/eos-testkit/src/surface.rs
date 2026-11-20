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
