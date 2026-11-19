use super::*;

fn at(state: HealthState, code: Option<StateCode>, failures: u32) -> Health {
    Health { state, code, failures }
}

#[test]
fn states_and_codes_are_stored_as_their_words_and_read_back() {
    let words: Vec<&str> = HealthState::ALL.iter().map(|state| state.as_str()).collect();
    assert_eq!(words, ["ready", "degraded", "needs_sign_in", "needs_setup", "broken", "disabled", "available"]);
    for state in HealthState::ALL {
        assert_eq!(HealthState::parse(state.as_str()), Some(state));
    }
    let called: Vec<HealthState> = HealthState::ALL.into_iter().filter(|state| state.takes_calls()).collect();
    assert_eq!(called, [HealthState::Ready, HealthState::Degraded]);

    for code in [
        "secret_missing:api_key",
        "client_id_missing",
        "automation_denied",
        "http_401",
        "hash_mismatch",
        "program_missing",
        "sandbox_unavailable",
        "rate_limited",
        "health_failed",
        "output_schema",
    ] {
        assert_eq!(StateCode::parse(code).map(|code| code.as_string()).as_deref(), Some(code));
    }
    assert_eq!(StateCode::parse("secret_missing:token"), Some(StateCode::SecretMissing("token".into())));
    assert_eq!((StateCode::parse("secret_missing:"), StateCode::parse("http_500")), (None, None));
    assert_eq!(HealthState::parse("paused"), None);
}

#[test]
fn each_cause_of_g10_puts_a_working_capability_where_g10_says() {
    use HealthState::*;
    let setup = StateCode::SecretMissing("api_key".into());
    let cases = [
        (Event::Passed, at(Ready, None, 0)),
        (Event::Worked, at(Ready, None, 0)),
        (Event::RateLimited, at(Degraded, Some(StateCode::RateLimited), 0)),
        (Event::CallFailed, at(Degraded, None, 0)),
        (Event::CheckFailed, at(Degraded, Some(StateCode::HealthFailed), 1)),
        (Event::BadOutput, at(Ready, None, 1)),
        (Event::Unauthorized, at(NeedsSignIn, Some(StateCode::Http401), 0)),
        (Event::Missing(setup.clone()), at(NeedsSetup, Some(setup.clone()), 0)),
        (Event::Missing(StateCode::AutomationDenied), at(NeedsSetup, Some(StateCode::AutomationDenied), 0)),
        (Event::HashMismatch, at(Broken, Some(StateCode::HashMismatch), 0)),
        (Event::SandboxUnavailable, at(Broken, Some(StateCode::SandboxUnavailable), 0)),
        (Event::Disabled, at(Disabled, None, 0)),
    ];
    for (event, expected) in cases {
        assert_eq!(Health::ready().after(event.clone()), expected, "{event:?}");
    }
}

#[test]
fn three_failed_checks_or_broken_outputs_in_a_row_break_it_and_a_pass_resets_the_count() {
    let once = Health::ready().after(Event::CheckFailed);
    let twice = once.after(Event::CheckFailed);
    assert_eq!(twice, at(HealthState::Degraded, Some(StateCode::HealthFailed), 2), "still called");
    assert_eq!(twice.after(Event::CheckFailed), at(HealthState::Broken, Some(StateCode::HealthFailed), 3));
    assert_eq!(twice.after(Event::Passed), Health::ready(), "a pass in between starts the count again");

    let outputs = Health::ready().after(Event::BadOutput).after(Event::BadOutput);
    assert_eq!(outputs, at(HealthState::Ready, None, 2), "a broken output alone does not degrade it");
    assert_eq!(outputs.after(Event::BadOutput), at(HealthState::Broken, Some(StateCode::OutputSchema), 3));
    let limited = Health::ready().after(Event::RateLimited).after(Event::BadOutput);
    assert_eq!(limited, at(HealthState::Degraded, Some(StateCode::RateLimited), 1));
}

#[test]
fn a_passed_check_keeps_the_count_of_broken_outputs_and_only_an_output_that_fits_resets_it() {
    let once = Health::ready().after(Event::BadOutput).after(Event::Passed);
    let twice = once.after(Event::BadOutput).after(Event::Passed);
    assert_eq!(twice, at(HealthState::Ready, None, 2), "the early checks after each one passed");
    assert_eq!(twice.after(Event::BadOutput), at(HealthState::Broken, Some(StateCode::OutputSchema), 3));

    let fitted = twice.after(Event::Worked);
    assert_eq!(fitted, Health::ready(), "an output that fits starts the count again");
    let again = fitted.after(Event::BadOutput).after(Event::Passed).after(Event::BadOutput).after(Event::Passed);
    assert_eq!(again, at(HealthState::Ready, None, 2));

    let checks = Health::ready().after(Event::CheckFailed).after(Event::BadOutput);
    assert_eq!(checks.after(Event::Passed), Health::ready(), "a pass still clears what checks count");
}

#[test]
fn a_refused_capability_leaves_its_state_only_when_a_check_passes_or_another_refusal_comes() {
    let refused = [
        at(HealthState::NeedsSignIn, Some(StateCode::Http401), 0),
        at(HealthState::NeedsSetup, Some(StateCode::ClientIdMissing), 0),
        at(HealthState::Broken, Some(StateCode::HashMismatch), 0),
        at(HealthState::Broken, Some(StateCode::HealthFailed), 3),
    ];
    for health in refused {
        assert_eq!(health.after(Event::RateLimited), health, "{health:?}");
        assert_eq!(health.after(Event::CallFailed), health, "{health:?}");
        assert_eq!(health.after(Event::CheckFailed), Health { failures: health.failures + 1, ..health.clone() });
        assert_eq!(health.after(Event::Passed), Health::ready(), "{health:?}: fixed, so its routines resume");
        assert_eq!(health.after(Event::Unauthorized).state, HealthState::NeedsSignIn);
        assert_eq!(health.after(Event::HashMismatch).code, Some(StateCode::HashMismatch));
        assert_eq!(health.after(Event::Disabled).state, HealthState::Disabled);
    }
}

#[test]
fn only_the_user_brings_back_a_capability_switched_off_or_not_installed_here() {
    let off = Health::ready().after(Event::Disabled);
    let available = at(HealthState::Available, None, 0);
    for health in [off, available] {
        for event in [Event::Passed, Event::Unauthorized, Event::CheckFailed, Event::HashMismatch, Event::Disabled] {
            assert_eq!(health.after(event.clone()).state, health.state, "{health:?} {event:?}");
        }
    }
    assert_eq!(Health::fresh(Event::Passed), Health::ready(), "switched on, and its check passed");
    assert_eq!(Health::fresh(Event::Unauthorized).state, HealthState::NeedsSignIn, "switched on, and still signed out");
    assert_eq!(
        Health::fresh(Event::Missing(StateCode::ProgramMissing)),
        at(HealthState::NeedsSetup, Some(StateCode::ProgramMissing), 0),
        "installed on a Mac without its program"
    );
}
