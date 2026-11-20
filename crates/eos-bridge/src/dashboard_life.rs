//! When the dashboard's view is let go and made again. A window hidden for long frees the
//! dashboard's renderer, the larger part of what the app holds; the core, the doors and the
//! other child views go on without it. Showing the window makes the view again.

/// How long the window stays hidden before the dashboard's view is released.
pub const DASHBOARD_RELEASE_AFTER_MS: u64 = 600_000;

/// What the shell sees at one look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seen {
    /// The window is on screen, or is being shown.
    pub visible: bool,
    /// The dashboard's view exists.
    pub loaded: bool,
    /// The dashboard's DevTools are open: someone is working on the page.
    pub devtools_open: bool,
}

/// What the shell does after a look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardStep {
    Keep,
    /// Close the dashboard's view.
    Release,
    /// Make the dashboard's view again and load the page.
    Recreate,
}

#[derive(Debug, Clone)]
pub struct DashboardLife {
    after_ms: u64,
    hidden_since: Option<u64>,
    released: bool,
}

impl DashboardLife {
    pub fn new(after_ms: u64) -> Self {
        DashboardLife { after_ms, hidden_since: None, released: false }
    }

    /// Whether this rule closed the dashboard's view and has not made it again.
    pub fn released(&self) -> bool {
        self.released
    }

    /// Takes one look at the window. Only a view this rule released is made again: a hidden
    /// start loads the dashboard on its first showing by itself.
    pub fn step(&mut self, now_ms: u64, seen: Seen) -> DashboardStep {
        if seen.visible {
            self.hidden_since = None;
            if self.released {
                self.released = false;
                return DashboardStep::Recreate;
            }
            return DashboardStep::Keep;
        }
        if !seen.loaded {
            self.hidden_since = None;
            return DashboardStep::Keep;
        }
        let since = *self.hidden_since.get_or_insert(now_ms);
        if seen.devtools_open || now_ms.saturating_sub(since) < self.after_ms {
            return DashboardStep::Keep;
        }
        self.hidden_since = None;
        self.released = true;
        DashboardStep::Release
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    fn seen(visible: bool, loaded: bool, devtools_open: bool) -> Seen {
        Seen { visible, loaded, devtools_open }
    }

    #[test]
    fn ten_minutes_hidden_release_the_view_and_showing_makes_it_again() {
        let mut life = DashboardLife::new(DASHBOARD_RELEASE_AFTER_MS);
        assert_eq!(life.step(0, seen(true, true, false)), DashboardStep::Keep);
        assert_eq!(life.step(MIN, seen(false, true, false)), DashboardStep::Keep, "the window was just hidden");
        assert_eq!(life.step(10 * MIN, seen(false, true, false)), DashboardStep::Keep, "nine minutes");
        assert_eq!(life.step(11 * MIN, seen(false, true, false)), DashboardStep::Release);
        assert!(life.released());
        assert_eq!(life.step(12 * MIN, seen(false, false, false)), DashboardStep::Keep, "released once");
        assert_eq!(life.step(60 * MIN, seen(false, false, false)), DashboardStep::Keep);
        assert_eq!(life.step(61 * MIN, seen(true, false, false)), DashboardStep::Recreate);
        assert!(!life.released());
        assert_eq!(life.step(61 * MIN + 5_000, seen(true, false, false)), DashboardStep::Keep, "made once");
    }

    #[test]
    fn showing_the_window_starts_the_ten_minutes_again() {
        let mut life = DashboardLife::new(DASHBOARD_RELEASE_AFTER_MS);
        life.step(0, seen(false, true, false));
        assert_eq!(life.step(9 * MIN, seen(true, true, false)), DashboardStep::Keep);
        assert_eq!(life.step(10 * MIN, seen(false, true, false)), DashboardStep::Keep);
        assert_eq!(
            life.step(19 * MIN, seen(false, true, false)),
            DashboardStep::Keep,
            "nine minutes since hidden again"
        );
        assert_eq!(life.step(20 * MIN, seen(false, true, false)), DashboardStep::Release);
    }

    #[test]
    fn open_devtools_keep_the_view() {
        let mut life = DashboardLife::new(DASHBOARD_RELEASE_AFTER_MS);
        life.step(0, seen(false, true, true));
        assert_eq!(life.step(30 * MIN, seen(false, true, true)), DashboardStep::Keep);
        assert_eq!(life.step(31 * MIN, seen(false, true, false)), DashboardStep::Release, "hidden all along");
    }

    #[test]
    fn a_hidden_start_has_nothing_to_release_or_make_again() {
        let mut life = DashboardLife::new(DASHBOARD_RELEASE_AFTER_MS);
        assert_eq!(life.step(0, seen(false, false, false)), DashboardStep::Keep);
        assert_eq!(life.step(30 * MIN, seen(false, false, false)), DashboardStep::Keep);
        assert_eq!(life.step(31 * MIN, seen(true, false, false)), DashboardStep::Keep, "the first showing loads it");
        assert_eq!(life.step(32 * MIN, seen(false, true, false)), DashboardStep::Keep);
        assert_eq!(
            life.step(42 * MIN, seen(false, true, false)),
            DashboardStep::Release,
            "ten minutes from loaded and hidden"
        );
    }

    #[test]
    fn a_clock_set_back_does_not_release_early() {
        let mut life = DashboardLife::new(DASHBOARD_RELEASE_AFTER_MS);
        life.step(100 * MIN, seen(false, true, false));
        assert_eq!(life.step(50 * MIN, seen(false, true, false)), DashboardStep::Keep);
    }
}
