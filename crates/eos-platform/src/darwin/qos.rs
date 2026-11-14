//! The calling thread's quality-of-service class, through libSystem's pthread calls.
//! The only `unsafe` outside the window shell's native module (ARCHITECTURE §5): each call
//! takes plain values and touches nothing but the calling thread's own scheduling class.
#![allow(unsafe_code)]

use libc::{c_int, qos_class_t};

use crate::thread_class::ThreadClass;

pub(crate) fn set(class: ThreadClass) {
    let raw = match class {
        ThreadClass::UserInitiated => qos_class_t::QOS_CLASS_USER_INITIATED,
        ThreadClass::Utility => qos_class_t::QOS_CLASS_UTILITY,
    };
    set_raw(raw, 0);
}

fn set_raw(class: qos_class_t, relative: c_int) {
    // SAFETY: plain values in; changes only the calling thread's class. A refusal (a thread
    // the system manages itself) leaves the class as it was, which is all a caller could do.
    let _ = unsafe { libc::pthread_set_qos_class_self_np(class, relative) };
}

/// The calling thread's class and its relative priority within it.
fn current() -> (qos_class_t, c_int) {
    let mut class = qos_class_t::QOS_CLASS_UNSPECIFIED;
    let mut relative: c_int = 0;
    // SAFETY: `pthread_self` names the calling thread, alive for the whole call; both
    // out-pointers are locals the call only writes a class and an int through.
    unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &raw mut class, &raw mut relative) };
    (class, relative)
}

/// Puts the calling thread back in the class it had when this was made.
pub(crate) struct Restore(qos_class_t, c_int);

impl Restore {
    pub(crate) fn current() -> Self {
        let (class, relative) = current();
        Self(class, relative)
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        // A thread that never chose a class runs at the default one; the call cannot name "none".
        let class = match self.0 {
            qos_class_t::QOS_CLASS_UNSPECIFIED => qos_class_t::QOS_CLASS_DEFAULT,
            class => class,
        };
        set_raw(class, self.1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread_class::{in_thread_class, set_thread_class};

    fn class_now() -> u32 {
        current().0 as u32
    }

    #[test]
    fn a_thread_takes_the_class_it_asks_for_and_gets_its_own_back() {
        std::thread::spawn(|| {
            set_thread_class(ThreadClass::UserInitiated);
            assert_eq!(class_now(), qos_class_t::QOS_CLASS_USER_INITIATED as u32);

            let inside = in_thread_class(ThreadClass::Utility, class_now);
            assert_eq!(inside, qos_class_t::QOS_CLASS_UTILITY as u32);
            assert_eq!(class_now(), qos_class_t::QOS_CLASS_USER_INITIATED as u32);

            let panicked = std::panic::catch_unwind(|| in_thread_class(ThreadClass::Utility, || panic!("work failed")));
            assert!(panicked.is_err());
            assert_eq!(class_now(), qos_class_t::QOS_CLASS_USER_INITIATED as u32, "restored after a panic too");
        })
        .join()
        .expect("thread");
    }

    #[test]
    fn a_thread_without_a_class_returns_to_the_default_one() {
        std::thread::spawn(|| {
            in_thread_class(ThreadClass::Utility, || ());
            let back = class_now();
            assert!(
                back == qos_class_t::QOS_CLASS_DEFAULT as u32 || back == qos_class_t::QOS_CLASS_UNSPECIFIED as u32,
                "class {back:#x}"
            );
        })
        .join()
        .expect("thread");
    }
}
