//! What the window does on the core's own events: banners, the machine switcher kept
//! current, transfer changes for the views of other computers, and the menu-bar item's
//! counts ([`Duty`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_bridge::{Bridge, Core, Plane};
use eos_runtime::bus::{Bus, RecvError};
use eos_shell::{MenuState, NextRun};
use serde_json::Value;
use tokio::runtime::Handle;

/// How many events of one topic may wait for the window.
const QUEUE: usize = 64;
/// Link state ticks (latency) arrive in bursts: one read of the hosts per burst.
const HOSTS_SETTLE: Duration = Duration::from_millis(150);

/// Hands each event of `topic` to `act` while `target` lives.
fn follow<T: Send + Sync + 'static>(
    bus: &Bus,
    rt: &Handle,
    target: &Arc<T>,
    topic: &'static str,
    act: impl Fn(&Arc<T>, Value) + Send + 'static,
) {
    let mut events = bus.subscribe(topic, QUEUE);
    let target = Arc::downgrade(target);
    rt.spawn(async move {
        loop {
            let payload = match events.recv().await {
                Ok(event) => event.payload_as::<Value>().unwrap_or(Value::Null),
                // A burst the window did not keep up with: what it is about is read again.
                Err(RecvError::Lagged(_)) => Value::Null,
                Err(RecvError::Closed) => return,
            };
            let Some(target) = target.upgrade() else { return };
            act(&target, payload);
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

/// Changes to Needs you and to routines come in bursts: one read per burst.
const DUTY_SETTLE: Duration = Duration::from_millis(250);

/// What the menu-bar item shows, kept current from the core's events and read through the
/// core's routes as the dashboard reads them. Counts and the next routine's name only.
pub(crate) struct Duty {
    core: Arc<dyn Core>,
    rt: Handle,
    push: Arc<dyn Fn(MenuState) + Send + Sync>,
    state: Mutex<MenuState>,
    settling: AtomicBool,
}

fn count(value: Option<&Value>) -> u32 {
    value.and_then(Value::as_i64).map_or(0, |n| u32::try_from(n.max(0)).unwrap_or(u32::MAX))
}

/// The routine that runs soonest, by its name: `routines` from `GET /api/routines`, `next`
/// from `GET /api/signals/routines`.
fn next_run(routines: &Value, next: &Value) -> Option<NextRun> {
    let (at_ms, id) = next
        .as_array()?
        .iter()
        .filter_map(|row| Some((row.get("nextAt")?.as_i64()?, row.get("routineId")?.as_str()?)))
        .min()?;
    let routine = routines.as_array()?.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id))?;
    Some(NextRun { name: routine.get("name")?.as_str()?.to_owned(), at_ms })
}

impl Duty {
    /// Reads what the item shows, then follows it; every change is handed to `push`.
    pub(crate) fn start(
        bus: &Bus,
        rt: &Handle,
        core: Arc<dyn Core>,
        push: Arc<dyn Fn(MenuState) + Send + Sync>,
    ) -> Arc<Self> {
        let duty =
            Arc::new(Duty { core, rt: rt.clone(), push, state: Mutex::default(), settling: AtomicBool::new(false) });
        follow(bus, rt, &duty, "runs:active", |duty, payload| match payload.get("count") {
            Some(working) => duty.change(|state| state.working = count(Some(working))),
            None => duty.read(Duty::read_runs),
        });
        follow(bus, rt, &duty, "inbox:halt", |duty, payload| match payload.get("on").and_then(Value::as_bool) {
            Some(on) => duty.change(|state| state.halted = on),
            None => duty.read(Duty::read_halt),
        });
        for topic in ["inbox:change", "signals:change", "routine:change"] {
            follow(bus, rt, &duty, topic, |duty, _| duty.settle());
        }
        let first = duty.clone();
        rt.spawn(async move {
            first.clone().read_runs().await;
            first.clone().read_halt().await;
            first.clone().read_waiting().await;
            // The item shows from the first reads on, whatever they found.
            let state = first.state.lock().unwrap_or_else(|p| p.into_inner()).clone();
            (first.push)(state);
        });
        duty
    }

    /// Runs of routines working, as the item shows them.
    pub(crate) fn working(&self) -> u32 {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).working
    }

    fn change(&self, edit: impl FnOnce(&mut MenuState)) {
        let changed = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let before = state.clone();
            edit(&mut state);
            (*state != before).then(|| state.clone())
        };
        if let Some(state) = changed {
            (self.push)(state);
        }
    }

    fn read<F: Future<Output = ()> + Send + 'static>(self: &Arc<Self>, read: fn(Arc<Self>) -> F) {
        self.rt.spawn(read(self.clone()));
    }

    /// Reads Needs you and the routines again once a burst of changes is over.
    fn settle(self: &Arc<Self>) {
        if self.settling.swap(true, Ordering::SeqCst) {
            return;
        }
        let duty = self.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(DUTY_SETTLE).await;
            duty.settling.store(false, Ordering::SeqCst);
            duty.read_waiting().await;
        });
    }

    /// A read route's JSON answer; `None` when it did not answer 200.
    async fn get(&self, target: &str) -> Option<Value> {
        let token = self.core.ui_token();
        match eos_bridge::ask::ask(self.core.as_ref(), Plane::Api, "GET", target, &token, None).await {
            Ok((200, body)) => Some(body),
            Ok((status, _)) => {
                tracing::debug!(target: "eos", target, status, "the menu-bar item's read was refused");
                None
            }
            Err(_) => None,
        }
    }

    async fn read_runs(self: Arc<Self>) {
        if let Some(active) = self.get("/api/runs/active").await {
            self.change(|state| state.working = count(active.get("count")));
        }
    }

    async fn read_halt(self: Arc<Self>) {
        if let Some(halt) = self.get("/api/eos/halt").await {
            self.change(|state| state.halted = halt.get("on").and_then(Value::as_bool).unwrap_or(false));
        }
    }

    /// Needs you's open items and the routine that runs next.
    async fn read_waiting(self: Arc<Self>) {
        let inbox = self.get("/api/inbox").await;
        let (routines, next) = (self.get("/api/routines").await, self.get("/api/signals/routines").await);
        self.change(|state| {
            if let Some(inbox) = &inbox {
                state.needs_you = count(inbox.pointer("/counts/open"));
            }
            if let (Some(routines), Some(next)) = (&routines, &next) {
                state.next = next_run(routines, next);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_next_run_is_the_soonest_by_its_routine_name() {
        let routines = json!([{"id": "r1", "name": "PR Review"}, {"id": "r2", "name": "Morning Paper"}]);
        let next = json!([
            {"routineId": "r1", "nextAt": 2000, "sourcesOk": true},
            {"routineId": "r2", "nextAt": 1000, "sourcesOk": true},
            {"routineId": "r3", "sourcesOk": true},
        ]);
        assert_eq!(next_run(&routines, &next), Some(NextRun { name: "Morning Paper".into(), at_ms: 1000 }));
        assert_eq!(next_run(&routines, &json!([{"routineId": "r1", "sourcesOk": true}])), None, "nothing scheduled");
    }
}
