use super::*;

const RUN_ROLES: [RunRole; 5] = [RunRole::Solo, RunRole::Lead, RunRole::Script, RunRole::Specialist, RunRole::Checker];
const FORGE_ROLES: [RunRole; 3] = [RunRole::ForgeResearcher, RunRole::ForgeBuilder, RunRole::ForgeReviewer];
const CAPABILITY_TOOLS: [&str; 2] = ["list_capabilities", "call_capability"];
const WORKTREE: &str = "/Users/me/.eos/routines/rn-0a1b2c3d4e5f/work";

const READS: [&str; 4] = ["Read", "Glob", "Grep", "LS"];
const EDITS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SHELL: [&str; 4] = ["Bash", "BashOutput", "KillBash", "KillShell"];
const WEB: [&str; 2] = ["WebFetch", "WebSearch"];

/// Never allowed in any run: MCP tools, browser verbs, the Artifact tools,
/// Workflow, and every built-in the class map leaves out.
const NEVER: [&str; 12] = [
    "mcp__github__create_pull_request",
    "browser_click",
    "browser_snapshot",
    "Artifact",
    "ArtifactComments",
    "ArtifactData",
    "Workflow",
    "AskUserQuestion",
    "Task",
    "TodoWrite",
    "Skill",
    "ExitPlanMode",
];

fn scope(role: RunRole, trust: Trust) -> ToolScope {
    scope_for(role, trust, &CAPABILITY_TOOLS, None, WORKTREE)
}

fn names(groups: &[&[&str]]) -> Vec<String> {
    groups.iter().flat_map(|group| group.iter()).map(|tool| (*tool).to_owned()).collect()
}

fn definition(allow: &[&str], deny: &[&str]) -> ToolScope {
    ToolScope {
        allow: allow.iter().map(|tool| (*tool).to_owned()).collect(),
        deny: deny.iter().map(|tool| (*tool).to_owned()).collect(),
        edit_regex: Some("\\.md$".to_owned()),
    }
}

#[test]
fn every_run_role_gets_reads_edits_the_shell_the_web_and_capabilities_trusted_or_not() {
    for role in RUN_ROLES {
        for trust in Trust::ALL {
            let scope = scope(role, trust);
            assert_eq!(scope.allow, names(&[&READS, &EDITS, &SHELL, &WEB, &CAPABILITY_TOOLS]), "{role:?} {trust:?}");
            assert_eq!(scope.deny, ["Bash(git push:*)", "Bash(gh:*)"], "{role:?} {trust:?}");
            assert_eq!(scope.edit_regex.as_deref(), Some(r"^/Users/me/\.eos/routines/rn-0a1b2c3d4e5f/work/"));
        }
    }
}

#[test]
fn the_forge_roles_get_their_own_rows() {
    for trust in Trust::ALL {
        let researcher = scope(RunRole::ForgeResearcher, trust);
        assert_eq!(researcher.allow, names(&[&READS, &WEB]));
        let builder = scope(RunRole::ForgeBuilder, trust);
        assert_eq!(builder.allow, names(&[&READS, &EDITS, &SHELL]));
        let reviewer = scope(RunRole::ForgeReviewer, trust);
        assert_eq!(reviewer.allow, names(&[&READS]));
        for scope in [researcher, builder, reviewer] {
            assert_eq!(scope.deny, ["Bash(git push:*)", "Bash(gh:*)"]);
        }
    }
}

#[test]
fn each_group_of_the_class_map_reaches_the_roles_its_rows_name() {
    for role in RUN_ROLES.into_iter().chain(FORGE_ROLES) {
        for trust in Trust::ALL {
            let allow = scope(role, trust).allow;
            let has = |tools: &[&str]| tools.iter().all(|tool| allow.iter().any(|allowed| allowed == tool));
            let has_none = |tools: &[&str]| tools.iter().all(|tool| !allow.iter().any(|allowed| allowed == tool));
            let routine = RUN_ROLES.contains(&role);
            // Class read: every role.
            assert!(has(&READS), "{role:?}");
            // Class write_local: those that build something.
            let edits = routine || role == RunRole::ForgeBuilder;
            assert!(if edits { has(&EDITS) } else { has_none(&EDITS) }, "{role:?}");
            // The shell and the web: no class of their own.
            assert!(if edits { has(&SHELL) } else { has_none(&SHELL) }, "{role:?}");
            let web = routine || role == RunRole::ForgeResearcher;
            assert!(if web { has(&WEB) } else { has_none(&WEB) }, "{role:?}");
            assert!(if routine { has(&CAPABILITY_TOOLS) } else { has_none(&CAPABILITY_TOOLS) }, "{role:?}");
            // Denied: the allow list names every tool it allows, exactly.
            assert!(has_none(&NEVER), "{role:?} {trust:?}");
            assert!(allow.iter().all(|tool| !tool.contains(['*', '('])), "{role:?}");
        }
    }
}

#[test]
fn a_definition_narrows_the_scope_and_never_widens_it() {
    let narrowed =
        |def: &ToolScope| scope_for(RunRole::Specialist, Trust::Untrusted, &CAPABILITY_TOOLS, Some(def), WORKTREE);

    let reader = narrowed(&definition(&["Read", "Grep", "Bash", "mcp__*", "Artifact"], &["WebFetch", "Bash(gh:*)"]));
    assert_eq!(reader.allow, ["Read", "Grep", "Bash"]);
    assert_eq!(reader.deny, ["Bash(git push:*)", "Bash(gh:*)", "WebFetch"]);
    // The run's folder bounds edits, whatever the definition says.
    assert_eq!(reader.edit_regex.as_deref(), Some(r"^/Users/me/\.eos/routines/rn-0a1b2c3d4e5f/work/"));

    assert_eq!(narrowed(&definition(&["Web*"], &[])).allow, ["WebFetch", "WebSearch"]);
    assert_eq!(narrowed(&definition(&["*"], &[])).allow, scope(RunRole::Specialist, Trust::Untrusted).allow);
    let deny_only = narrowed(&definition(&[], &["Bash(rm:*)"]));
    assert_eq!(deny_only.allow, scope(RunRole::Specialist, Trust::Untrusted).allow);
    assert_eq!(deny_only.deny, ["Bash(git push:*)", "Bash(gh:*)", "Bash(rm:*)"]);

    // A definition that allows nothing the run has leaves nothing allowed,
    // not everything.
    for allow in [&["mcp__github__*", "Artifact", "Workflow"][..], &["Bash(npm test:*)"][..]] {
        let none = narrowed(&definition(allow, &[]));
        assert!(none.allow.is_empty());
        assert_eq!(none.deny.last().map(String::as_str), Some("*"));
    }
}

#[test]
fn an_allow_pattern_covers_tools_by_name_as_the_policy_does() {
    assert!(covers("*", "Read"));
    assert!(covers("Read", "Read"));
    assert!(!covers("Bash", "BashOutput"));
    assert!(covers("Bash*", "BashOutput") && covers("Bash*", "Bash"));
    assert!(covers("*Edit", "MultiEdit") && !covers("*Edit", "Editor"));
    assert!(covers("K*ll*", "KillShell") && covers("*i*l*", "KillBash"));
    assert!(covers("N*Edit", "NotebookEdit") && !covers("N*Edit*x", "NotebookEdit"));
    assert!(!covers("Edit*Edit", "Edit"), "the two parts may not overlap");
    assert!(!covers("Bash(npm test:*)", "Bash") && !covers("Bash(*)", "Bash"));
    assert!(!covers("mcp__*", "Read"));
}

#[test]
fn edits_stay_in_the_folder_whatever_its_name_holds() {
    let edits_in = |folder: &str, path: &str| {
        let pattern = scope_for(RunRole::Solo, Trust::Trusted, &[], None, folder).edit_regex.expect("an edit regex");
        regress::Regex::new(&pattern).expect("a regex").find(path).is_some()
    };
    assert!(edits_in(WORKTREE, &format!("{WORKTREE}/src/main.rs")));
    assert!(!edits_in(WORKTREE, &format!("{WORKTREE}2/src/main.rs")));
    assert!(!edits_in(WORKTREE, "/Users/me/.ssh/config"));
    assert!(!edits_in(WORKTREE, &format!("/tmp{WORKTREE}/x")));
    let odd = "/tmp/a+b (1)/[x].$y";
    assert!(edits_in(odd, "/tmp/a+b (1)/[x].$y/file"));
    assert!(!edits_in(odd, "/tmp/aab (1)/[x].$y/file"));
    assert!(edits_in("/tmp/run/", "/tmp/run/file"));
}

#[test]
fn trust_is_stored_as_its_word_and_read_back() {
    assert_eq!(Trust::ALL.map(Trust::as_str), ["trusted", "untrusted"]);
    for trust in Trust::ALL {
        assert_eq!(Trust::parse(trust.as_str()), Some(trust));
    }
    assert_eq!(Trust::parse("Untrusted"), None);
}
