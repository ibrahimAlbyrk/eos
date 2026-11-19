//! The runner of a computer that shares nothing with the user's others:
//! every routine is held here, and a claim moves nothing but locally.

use eos_core::BoxFuture;
use eos_core::signals::{DeviceReport, DeviceSeen, Handoff, Holder, Runner, RunnerError};

/// The epoch every routine is held at here.
const EPOCH: i64 = 1;

#[derive(Debug, Clone)]
pub struct SoloRunner {
    device_id: String,
}

impl SoloRunner {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self { device_id: device_id.into() }
    }
}

impl Runner for SoloRunner {
    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn holder(&self, _routine_id: &str) -> Holder {
        Holder::Here { epoch: EPOCH }
    }

    fn adopt<'a>(&'a self, _routine_id: &'a str) -> BoxFuture<'a, Result<(), RunnerError>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn claim<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Handoff, RunnerError>> {
        let handoff = Handoff { routine_id: routine_id.to_owned(), epoch: EPOCH, watermarks: None };
        Box::pin(std::future::ready(Ok(handoff)))
    }

    fn report<'a>(&'a self, _report: &'a DeviceReport) -> BoxFuture<'a, Result<(), RunnerError>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn devices(&self) -> Vec<DeviceSeen> {
        Vec::new()
    }

    fn confirmed_at(&self) -> Option<i64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_routine_is_held_here_and_a_claim_moves_nothing_elsewhere() {
        let runner = SoloRunner::new("dev-1");
        assert_eq!((runner.device_id(), runner.holder("rt-1")), ("dev-1", Holder::Here { epoch: 1 }));
        runner.adopt("rt-2").await.expect("adopts");
        let handoff = runner.claim("rt-1").await.expect("claims");
        assert_eq!((handoff.epoch, handoff.watermarks), (1, None));
        assert!(runner.devices().is_empty() && runner.confirmed_at().is_none(), "it shares nothing");
    }
}
