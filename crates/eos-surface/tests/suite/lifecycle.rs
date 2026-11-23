use eos_surface::limits::{KEPT_ISSUES, KEPT_VERSIONS, TRIAL_ISSUE_MS};
use eos_surface::{
    IssueAge, IssueStatus, Level, PinError, VersionAge, VersionStatus, arrange_pins, issues_to_drop, pin_slot,
    versions_to_drop,
};

#[test]
fn words_round_trip_and_unknown_words_are_none() {
    for status in VersionStatus::ALL {
        assert_eq!(VersionStatus::parse(status.as_str()), Some(*status));
    }
    assert_eq!(Level::parse("page"), Some(Level::Page));
    assert_eq!(Level::parse("Page"), None);
}

#[test]
fn versions_move_forward_only() {
    use VersionStatus::*;
    assert!(Checking.can_move_to(Candidate) && Candidate.can_move_to(Kept) && Kept.can_move_to(Superseded));
    assert!(Checking.can_move_to(Discarded) && Candidate.can_move_to(Discarded));
    assert!(!Kept.can_move_to(Candidate) && !Superseded.can_move_to(Kept) && !Discarded.can_move_to(Kept));
    assert!(!Checking.can_move_to(Kept), "a version is kept only after its checks pass");
    assert!(IssueStatus::Preparing.can_move_to(IssueStatus::Ready));
    assert!(!IssueStatus::Ready.can_move_to(IssueStatus::Preparing));
}

fn issue(n: usize, kept: bool, trial: bool) -> IssueAge {
    IssueAge { id: format!("si-{n:012}"), created_at: n as i64, kept, trial }
}

#[test]
fn the_newest_issues_and_the_kept_ones_stay() {
    let mut issues: Vec<IssueAge> = (0..KEPT_ISSUES + 3).map(|n| issue(n, n == 1, false)).collect();
    issues.push(issue(500, false, true));
    let dropped = issues_to_drop(&issues, Some(0), 10);
    assert_eq!(dropped, vec![issue(2, false, false).id, issue(0, false, false).id]);
    let later = issues_to_drop(&issues, Some(0), TRIAL_ISSUE_MS);
    assert_eq!(later.first(), Some(&issue(500, false, true).id), "trial issues go a week after the start");
    assert!(issues_to_drop(&issues[..3], None, i64::MAX).is_empty());
}

#[test]
fn versions_in_use_current_and_open_ones_are_never_dropped() {
    let mut versions: Vec<VersionAge> = (1..=KEPT_VERSIONS as i64 + 4)
        .map(|version| VersionAge { version, status: VersionStatus::Superseded })
        .collect();
    versions[0].status = VersionStatus::Kept;
    versions.push(VersionAge { version: 99, status: VersionStatus::Candidate });
    let dropped = versions_to_drop(&versions, &[2]);
    assert_eq!(dropped, vec![4, 3]);
}

#[test]
fn three_pins_at_most_one_slot_per_surface() {
    let pins = vec![(1, "sf-a".to_owned()), (3, "sf-c".to_owned())];
    assert_eq!(pin_slot(&pins, "sf-c"), Ok(3));
    assert_eq!(pin_slot(&pins, "sf-b"), Ok(2));
    let full = vec![(1, "a".to_owned()), (2, "b".to_owned()), (3, "c".to_owned())];
    assert_eq!(pin_slot(&full, "d"), Err(PinError::Full));
    let ids: Vec<String> = ["b", "a", "b"].map(String::from).to_vec();
    assert_eq!(arrange_pins(&ids), Ok(vec![(1, "b".to_owned()), (2, "a".to_owned())]));
    let four: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
    assert_eq!(arrange_pins(&four), Err(PinError::Full));
}
