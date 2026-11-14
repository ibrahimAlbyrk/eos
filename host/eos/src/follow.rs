//! What the window does on the core's own events: banners, the machine switcher kept
//! current, and transfer changes for the views of other computers.

use std::sync::Arc;
use std::time::Duration;

use eos_bridge::Bridge;
use eos_runtime::bus::{Bus, RecvError};
use serde_json::Value;
use tokio::runtime::Handle;

/// How many events of one topic may wait for the window.
const QUEUE: usize = 64;
/// Link state ticks (latency) arrive in bursts: one read of the hosts per burst.
const HOSTS_SETTLE: Duration = Duration::from_millis(150);

fn follow(
    bus: &Bus,
    rt: &Handle,
    bridge: &Arc<Bridge>,
    topic: &'static str,
    act: impl Fn(&Bridge, Value) + Send + 'static,
) {
    let mut events = bus.subscribe(topic, QUEUE);
    let bridge = Arc::downgrade(bridge);
    rt.spawn(async move {
        loop {
            let payload = match events.recv().await {
                Ok(event) => event.payload_as::<Value>().unwrap_or(Value::Null),
                // A burst the window did not keep up with: what it is about is read again.
                Err(RecvError::Lagged(_)) => Value::Null,
                Err(RecvError::Closed) => return,
            };
            let Some(bridge) = bridge.upgrade() else { return };
            act(&bridge, payload);
        }
    });
}

pub(crate) fn events(bus: &Bus, bridge: &Arc<Bridge>, rt: &Handle) {
    follow(bus, rt, bridge, "notification:fire", |bridge, payload| {
        bridge.notify(&payload);
    });
    let settling = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let refresh_rt = rt.clone();
    follow(bus, rt, bridge, "hosts:change", move |bridge, _| {
        let Some(hosts) = bridge.hosts().cloned() else { return };
        if settling.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let settling = settling.clone();
        refresh_rt.spawn(async move {
            tokio::time::sleep(HOSTS_SETTLE).await;
            settling.store(false, std::sync::atomic::Ordering::SeqCst);
            hosts.refresh().await;
        });
    });
    follow(bus, rt, bridge, "transfer:change", |bridge, payload| {
        if let Some(hosts) = bridge.hosts() {
            hosts.forward_transfer(&payload);
        }
    });
}
