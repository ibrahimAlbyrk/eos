//! Surfaces as routines reach them, until the surfaces feature exists: every
//! call is answered and does nothing.

use eos_core::surface::SurfaceAuthoring;
use eos_core::{BoxFuture, Error};

pub(crate) struct NoSurfaces;

fn done() -> BoxFuture<'static, Result<(), Error>> {
    Box::pin(std::future::ready(Ok(())))
}

impl SurfaceAuthoring for NoSurfaces {
    fn create_for_routine<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        done()
    }

    fn keep<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        done()
    }

    fn archive_for_routine<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        done()
    }

    fn restore_for_routine<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        done()
    }
}
