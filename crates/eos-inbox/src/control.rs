//! The routines' ports, attached after they are built: the routines feature
//! is built with Needs you's gate and questions, so they hold its control
//! and its run outcomes weakly, as the feature holds them.

use std::sync::{Arc, OnceLock, Weak};

use eos_core::Error;
use eos_core::routine::{RoutineControl, RunOutcomes};

/// A port of the routines feature, attached once it exists.
pub(crate) struct Late<T: ?Sized>(OnceLock<Weak<T>>);

impl<T: ?Sized> Default for Late<T> {
    fn default() -> Self {
        Self(OnceLock::new())
    }
}

impl<T: ?Sized> Late<T> {
    /// The caller keeps `port` alive.
    pub(crate) fn attach(&self, port: &Arc<T>) {
        let _ = self.0.set(Arc::downgrade(port));
    }

    pub(crate) fn get(&self) -> Result<Arc<T>, Error> {
        self.0.get().and_then(Weak::upgrade).ok_or_else(|| Error::storage("the routines are not attached"))
    }
}

pub(crate) type LateControl = Late<dyn RoutineControl>;
pub(crate) type LateOutcomes = Late<dyn RunOutcomes>;
