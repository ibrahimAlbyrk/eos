//! The page, user-memory and user-profile rules against the TypeScript they
//! are ported from: every vector in `tests/fixtures/*-vectors.json` (frozen from the TypeScript, see `fixtures/README.md`)
//! must give what the TypeScript gave.

// Vector shapes, read once.
#![allow(clippy::large_enum_variant)]

use eos_contracts::{
    PageEditRequest, PageSummaryTasks, UserMemory, UserMemoryProposal, UserMemoryScope, UserProfile, UserProfilePatch,
};
use eos_domain::page::{apply_page_edit, page_excerpt, page_task_counts};
use eos_domain::user_memory::{
    find_duplicate_memory, find_duplicate_proposal, lint_memory_text, memories_in_scope, memory_similarity,
    normalize_memory_text, scope_covers, search_memories,
};
use eos_domain::user_profile::{apply_profile_patch, empty_user_profile, is_profile_empty, same_profile_content};
use serde::Deserialize;
use serde::de::DeserializeOwned;

#[derive(Deserialize)]
struct Fixture<T> {
    vectors: Vec<T>,
}

fn vectors<T: DeserializeOwned>(json: &str) -> Vec<T> {
    serde_json::from_str::<Fixture<T>>(json).expect("fixture").vectors
}

#[derive(Deserialize)]
struct PageVector {
    body: String,
    counts: PageSummaryTasks,
    excerpts: Vec<Excerpt>,
    edits: Vec<Edit>,
}

#[derive(Deserialize)]
struct Excerpt {
    max: usize,
    out: String,
}

#[derive(Deserialize)]
struct Edit {
    edit: PageEditRequest,
    ok: Option<String>,
    err: Option<String>,
}

#[test]
fn pages_are_read_and_edited_as_the_typescript_does() {
    let all: Vec<PageVector> = vectors(include_str!("fixtures/page-vectors.json"));
    assert!(all.len() > 300);
    let (mut edits, mut refused) = (0, 0);
    for v in &all {
        assert_eq!(page_task_counts(&v.body), v.counts, "counts of {:?}", v.body);
        for e in &v.excerpts {
            assert_eq!(page_excerpt(&v.body, e.max), e.out, "excerpt({}) of {:?}", e.max, v.body);
        }
        for e in &v.edits {
            let got = apply_page_edit(&v.body, &e.edit).map_err(|why| why.to_string());
            let want = e.ok.clone().ok_or_else(|| e.err.clone().expect("ok or err"));
            assert_eq!(got, want, "{:?} on {:?}", e.edit, v.body);
            edits += 1;
            refused += usize::from(got.is_err());
        }
    }
    assert!(edits > 1000 && refused > 100 && edits - refused > 400, "{edits} edits, {refused} refused");
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MemoryVector {
    Normalize {
        text: String,
        out: String,
    },
    Lint {
        text: String,
        out: Option<String>,
    },
    Similarity {
        a: String,
        b: String,
        out: f64,
    },
    Covers {
        scope: UserMemoryScope,
        project: Option<String>,
        out: bool,
    },
    #[serde(rename_all = "camelCase")]
    Pool {
        pool: Vec<UserMemory>,
        text: String,
        scope: UserMemoryScope,
        proposal: UserMemoryProposal,
        query: String,
        project: Option<String>,
        limit: usize,
        duplicate: Option<String>,
        duplicate_proposal: Option<String>,
        search: Vec<String>,
        in_scope: Vec<String>,
    },
}

fn ids(found: &[&UserMemory]) -> Vec<String> {
    found.iter().map(|m| m.id.0.clone()).collect()
}

#[test]
fn memories_are_compared_and_searched_as_the_typescript_does() {
    let all: Vec<MemoryVector> = vectors(include_str!("fixtures/user-memory-vectors.json"));
    assert!(all.len() > 900);
    for v in &all {
        match v {
            MemoryVector::Normalize { text, out } => assert_eq!(&normalize_memory_text(text), out, "{text:?}"),
            MemoryVector::Lint { text, out } => assert_eq!(&lint_memory_text(text), out, "{text:?}"),
            MemoryVector::Similarity { a, b, out } => assert_eq!(memory_similarity(a, b), *out, "{a:?} ~ {b:?}"),
            MemoryVector::Covers { scope, project, out } => {
                assert_eq!(scope_covers(scope, project.as_deref()), *out, "{scope:?} covers {project:?}");
            }
            MemoryVector::Pool {
                pool,
                text,
                scope,
                proposal,
                query,
                project,
                limit,
                duplicate,
                duplicate_proposal,
                search,
                in_scope,
            } => {
                let found = |m: Option<&UserMemory>| m.map(|m| m.id.0.clone());
                assert_eq!(&found(find_duplicate_memory(text, scope, pool)), duplicate, "duplicate of {text:?}");
                assert_eq!(
                    &found(find_duplicate_proposal(text, proposal, pool)),
                    duplicate_proposal,
                    "duplicate proposal {proposal:?} {text:?}"
                );
                let project = project.as_deref();
                assert_eq!(&ids(&search_memories(pool, query, project, *limit)), search, "search {query:?}");
                assert_eq!(&ids(&memories_in_scope(pool, project)), in_scope, "in scope {project:?}");
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ProfileVector {
    Empty { out: UserProfile },
    Patch { reset: bool, patch: UserProfilePatch, out: UserProfile, same: bool, empty: bool },
}

#[test]
fn profiles_are_patched_as_the_typescript_does() {
    let all: Vec<ProfileVector> = vectors(include_str!("fixtures/user-profile-vectors.json"));
    assert!(all.len() > 400);
    let mut cur = empty_user_profile();
    for (i, v) in all.iter().enumerate() {
        match v {
            ProfileVector::Empty { out } => assert_eq!(&empty_user_profile(), out),
            ProfileVector::Patch { reset, patch, out, same, empty } => {
                if *reset {
                    cur = empty_user_profile();
                }
                let next = apply_profile_patch(&cur, patch);
                assert_eq!(&next, out, "vector {i}: {patch:?}");
                assert_eq!(same_profile_content(&cur, &next), *same, "vector {i}: same content");
                assert_eq!(is_profile_empty(&next), *empty, "vector {i}: empty");
                cur = next;
            }
        }
    }
}
