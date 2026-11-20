//! The routines' control, attached after it is built: the routines feature
//! is built with Needs you's gate and questions, so they hold its control
//! weakly, as the feature holds them.

use std::sync::{Arc, OnceLock, Weak};

use eos_core::Error;
use eos_core::routine::RoutineControl;

#[derive(Default)]
pub(crate) struct LateControl(OnceLock<Weak<dyn RoutineControl>>);

impl LateControl {
    /// The caller keeps `control` alive.
    pub(crate) fn attach(&self, control: &Arc<dyn RoutineControl>) {
        let _ = self.0.set(Arc::downgrade(control));
    }

    pub(crate) fn get(&self) -> Result<Arc<dyn RoutineControl>, Error> {
        self.0.get().and_then(Weak::upgrade).ok_or_else(|| Error::storage("no routine control is attached"))
    }
}
