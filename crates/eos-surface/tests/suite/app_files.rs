//! The files an App may reach: paths below its root only, matched against
//! its manifest's globs.

use eos_surface::{FileRoot, FileScope, app_path, glob_matches};

#[test]
fn a_path_stays_below_the_root() {
    assert_eq!(app_path("levels/one.json"), Ok("levels/one.json"));
    for refused in ["", "/etc/passwd", "~/x", "../x", "levels/../../x", "a//b", "./a", "a\\b", "a\0b"] {
        assert!(app_path(refused).is_err(), "{refused:?} was taken");
    }
}

#[test]
fn globs_match_inside_one_folder_and_across_folders_with_two_stars() {
    assert!(glob_matches("levels/*.json", "levels/one.json"));
    assert!(!glob_matches("levels/*.json", "levels/deep/one.json"));
    assert!(!glob_matches("levels/*.json", "levels/one.txt"));
    assert!(glob_matches("levels/**/*.json", "levels/one.json"));
    assert!(glob_matches("levels/**/*.json", "levels/a/b/one.json"));
    assert!(glob_matches("notes.md", "notes.md"));
    assert!(!glob_matches("notes.md", "other.md"));
    assert!(glob_matches("a*b*c", "aXXbYc"));
    assert!(!glob_matches("a*b*c", "abX"));
    assert!(!glob_matches("*.json", ".json/x"));
}

#[test]
fn writing_needs_a_write_glob_and_reading_takes_either() {
    let scope =
        FileScope { root: FileRoot::Project, read: vec!["docs/*.md".into()], write: vec!["levels/*.json".into()] };
    assert!(scope.may_read("docs/a.md"));
    assert!(scope.may_read("levels/one.json"));
    assert!(!scope.may_write("docs/a.md"));
    assert!(scope.may_write("levels/one.json"));
    assert!(!scope.may_read("src/main.rs"));
}
