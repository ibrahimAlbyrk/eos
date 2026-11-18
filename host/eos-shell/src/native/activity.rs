//! The work hold: keeps the app out of App Nap while routines run or wait, through one
//! `NSProcessInfo` activity per reason, begun with the first hold of that reason and ended
//! when its last hold drops. Only the app's own process can hold off App Nap; a helper
//! process like `caffeinate` cannot.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::os::{AwakeHold, HoldReason, WorkHold};
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

/// All the system is told, whatever the reason.
const REASON: &str = "Eos is running a routine";

fn options(why: HoldReason) -> NSActivityOptions {
    match why {
        // No App Nap, and no idle system sleep, on battery too.
        HoldReason::Run => NSActivityOptions::UserInitiated,
        // No App Nap; the computer may still sleep when idle.
        HoldReason::Armed => NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
    }
}

/// The token of a begun activity: the system keeps the activity until it is ended.
struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// SAFETY: the token is only retained, released and handed back to `endActivity:`; retain
// counts are atomic and NSProcessInfo is thread-safe (the SDK marks it `NS_SWIFT_SENDABLE`).
unsafe impl Send for Activity {}

/// Any thread: NSProcessInfo is thread-safe, so a hold begins on whichever thread takes it.
fn begin(why: HoldReason) -> Activity {
    // The pool takes whatever the calls autorelease, on a thread that may have none.
    autoreleasepool(|_| {
        let reason = NSString::from_str(REASON);
        Activity(NSProcessInfo::processInfo().beginActivityWithOptions_reason(options(why), &reason))
    })
}

/// Any thread, as [`begin`]: a hold ends on whichever thread drops it.
fn end(activity: Activity) {
    autoreleasepool(|_| {
        // SAFETY: `activity` is a token `beginActivityWithOptions:reason:` returned, ended once.
        unsafe { NSProcessInfo::processInfo().endActivity(&activity.0) }
    });
}

/// A reason's activity and how many holds of that reason live.
struct Held {
    holds: usize,
    activity: Activity,
}

type Live = Mutex<HashMap<HoldReason, Held>>;

fn lock(live: &Live) -> MutexGuard<'_, HashMap<HoldReason, Held>> {
    live.lock().unwrap_or_else(|p| p.into_inner())
}

/// The shell's [`WorkHold`]: the holds of each reason share one activity.
#[derive(Default)]
pub(crate) struct Activities {
    live: Arc<Live>,
}

impl WorkHold for Activities {
    fn begin(&self, why: HoldReason) -> Option<Box<dyn AwakeHold>> {
        lock(&self.live).entry(why).or_insert_with(|| Held { holds: 0, activity: begin(why) }).holds += 1;
        Some(Box::new(Hold { why, live: self.live.clone() }))
    }
}

/// One live hold; dropping the last of its reason ends that reason's activity.
struct Hold {
    why: HoldReason,
    live: Arc<Live>,
}

impl AwakeHold for Hold {}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut live = lock(&self.live);
        let Some(held) = live.get_mut(&self.why) else { return };
        held.holds -= 1;
        if held.holds == 0
            && let Some(held) = live.remove(&self.why)
        {
            end(held.activity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holds(activities: &Activities, why: HoldReason) -> Option<usize> {
        lock(&activities.live).get(&why).map(|held| held.holds)
    }

    /// Begins and ends real activities, on the test's threads rather than the main thread.
    #[test]
    fn the_holds_of_a_reason_share_one_activity_until_the_last_drops() {
        let activities = Activities::default();
        let first = activities.begin(HoldReason::Run);
        let second = activities.begin(HoldReason::Run);
        let armed = activities.begin(HoldReason::Armed);
        assert_eq!(holds(&activities, HoldReason::Run), Some(2));
        assert_eq!(holds(&activities, HoldReason::Armed), Some(1));

        drop(first);
        assert_eq!(holds(&activities, HoldReason::Run), Some(1));
        std::thread::spawn(move || drop(second)).join().expect("dropped on another thread");
        assert_eq!(holds(&activities, HoldReason::Run), None, "the last hold ended the activity");
        assert_eq!(holds(&activities, HoldReason::Armed), Some(1));

        drop(armed);
        assert!(lock(&activities.live).is_empty());
        drop(activities.begin(HoldReason::Run));
        assert!(lock(&activities.live).is_empty(), "a later hold begins and ends its own activity");
    }
}
