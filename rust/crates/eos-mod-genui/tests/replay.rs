//! The visual-answer routes against the recorded wire: every step of
//! `37-genui`, and the steps of `33-settings` and `90-gates` these routes
//! answer, must read what today's daemon answered, events included.

mod support;

use eos_testkit::wire::Replay;
use support::{Fakes, Harness, SANDBOX};

const SETTINGS_STEPS: &[&str] = &["genui", "genui-save", "genui-save-without-token", "genui-bad-level"];
const GATES: &[&str] = &[
    "post-api-genui-views",
    "post-api-genui-apps",
    "get-api-genui-views-id",
    "get-api-genui-views-id-state",
    "put-api-genui-views-id-state",
    "get-api-genui-media-img",
    "get-api-genui-media-og",
    "get-api-genui-media-icon",
    "get-api-genui-map-style-json",
    "get-api-genui-map-t-path",
    "get-api-genui-geocode",
    "post-api-genui-places",
    "get-api-location",
    "get-api-settings-genui",
    "put-api-settings-genui",
];

#[tokio::test(flavor = "multi_thread")]
async fn the_recorded_scenarios_replay_equal() {
    let h = Harness::start(Fakes::default()).await;
    let replay = |only: &'static [&'static str]| Replay {
        router: &h.runtime.router,
        bus: &h.runtime.kernel.bus,
        clock: &h.clock,
        vars: &[("sandbox", SANDBOX)],
        skip: &[],
        only,
    };
    // In recording order: the settings scenario turns location sharing off,
    // which the later ones' answers show.
    for (scenario, only, steps) in
        [("33-settings", SETTINGS_STEPS, 4), ("37-genui", &[][..], 24), ("90-gates", GATES, 15)]
    {
        let replayed = replay(only).run(scenario).await;
        assert_eq!(replayed.steps, steps, "{scenario}");
        assert_eq!(replayed.differences, Vec::<String>::new(), "{scenario}");
    }
}
