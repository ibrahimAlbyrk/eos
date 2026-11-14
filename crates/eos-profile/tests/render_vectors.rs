//! The renderer against the TypeScript it is ported from: every vector in
//! `tests/fixtures/render-vectors.json` (frozen from the TypeScript, see `fixtures/README.md`) must render byte
//! for byte the same.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{UserMemory, UserProfile};
use eos_core::profile::{ProfileBlock, ProfileBlockInput, UserProfileBlocks};
use eos_core::prompt::{MemoryDoc, MemoryLevel, MemorySnapshot};
use eos_core::store::{UserMemoryStore, UserProfileStore};
use eos_profile::{
    DEFAULT_USER_PREFERENCES, ProfileBlocks, RenderOptions, RenderedUserProfile, build_user_profile_block,
    drop_known_lines, known_line_set, received_memory_lines, render_user_profile,
};
use eos_testkit::{FakeUserMemoryStore, FakeUserProfileStore};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opts {
    project: Option<String>,
    known_lines: Vec<String>,
    search_tool_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    text: String,
    tokens: i64,
    included_ids: Vec<String>,
    overflow: usize,
    empty: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Block {
    withheld: bool,
    budget_tokens: i64,
    text: Option<String>,
}

#[derive(Deserialize)]
struct Vector {
    profile: UserProfile,
    memories: Vec<UserMemory>,
    opts: Opts,
    out: Out,
    kind: String,
    block: Block,
}

#[derive(Deserialize)]
struct Drop {
    text: String,
    known: Vec<String>,
    rendered: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    source_id: String,
    source_label: String,
    native_for: Vec<String>,
    path: PathBuf,
    level: String,
    content: String,
}

#[derive(Deserialize)]
struct Snapshot {
    docs: Vec<Doc>,
}

#[derive(Deserialize)]
struct Received {
    kind: String,
    injected: bool,
    out: Vec<String>,
}

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
    drops: Vec<Drop>,
    snapshot: Snapshot,
    received: Vec<Received>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/render-vectors.json")).expect("fixture")
}

fn same(got: &RenderedUserProfile, want: &Out) -> bool {
    got.text == want.text
        && got.tokens == want.tokens
        && got.included_ids == want.included_ids
        && got.overflow == want.overflow
        && got.empty == want.empty
}

#[test]
fn the_block_is_rendered_byte_for_byte_as_the_typescript_renders_it() {
    let fixture = fixture();
    assert!(fixture.vectors.len() >= 300);
    let (mut stock, mut overflowed, mut withheld) = (0, 0, 0);
    for (i, v) in fixture.vectors.iter().enumerate() {
        let options = RenderOptions {
            project: v.opts.project.as_deref(),
            known_lines: &v.opts.known_lines,
            search_tool_name: v.opts.search_tool_name.as_deref(),
        };
        let got = render_user_profile(&v.profile, &v.memories, &options);
        assert_eq!(got.text, v.out.text, "vector {i}");
        assert!(same(&got, &v.out), "vector {i}: {got:?}");
        stock += usize::from(got.empty);
        overflowed += usize::from(got.overflow > 0);

        let input = ProfileBlockInput {
            kind: &v.kind,
            project: options.project,
            known_lines: options.known_lines,
            search_tool_name: options.search_tool_name,
        };
        let block = build_user_profile_block(&v.profile, &v.memories, &input);
        assert_eq!((block.withheld, block.budget_tokens), (v.block.withheld, v.block.budget_tokens), "vector {i}");
        match &v.block.text {
            Some(text) => {
                withheld += 1;
                assert_eq!(&block.text, text, "vector {i}: withheld");
                assert_eq!(text, DEFAULT_USER_PREFERENCES);
                assert!(block.empty && block.included_ids.is_empty() && block.overflow == 0);
            }
            None => {
                assert_eq!((&block.text, block.tokens, &block.included_ids), (&got.text, got.tokens, &got.included_ids))
            }
        }
    }
    assert!(
        stock > 20 && overflowed > 20 && withheld > 10,
        "{stock} stock, {overflowed} overflowed, {withheld} withheld"
    );
}

#[test]
fn known_lines_are_dropped_from_the_instructions_as_the_typescript_drops_them() {
    let fixture = fixture();
    assert!(fixture.drops.len() >= 100);
    for v in &fixture.drops {
        let mut profile = eos_domain::user_profile::empty_user_profile();
        profile.instructions = v.text.clone();
        let options = RenderOptions { known_lines: &v.known, ..RenderOptions::default() };
        assert_eq!(render_user_profile(&profile, &[] as &[UserMemory], &options).text, v.rendered, "{:?}", v.text);
        let kept = drop_known_lines(&v.text, &known_line_set(&v.known));
        assert_eq!(kept.is_empty(), v.rendered == DEFAULT_USER_PREFERENCES);
        assert!(kept.is_empty() || v.rendered.contains(&kept));
    }
}

#[test]
fn a_session_receives_the_memory_files_its_backend_loads_or_the_app_injects() {
    let fixture = fixture();
    let snapshot = MemorySnapshot {
        docs: fixture
            .snapshot
            .docs
            .into_iter()
            .map(|d| MemoryDoc {
                source_id: d.source_id,
                source_label: d.source_label,
                native_for: d.native_for,
                path: d.path,
                level: if d.level == "user" { MemoryLevel::User } else { MemoryLevel::Project },
                content: d.content,
            })
            .collect(),
    };
    assert_eq!(fixture.received.len(), 4);
    for v in &fixture.received {
        assert_eq!(received_memory_lines(&snapshot, &v.kind, v.injected), v.out, "{} injected={}", v.kind, v.injected);
    }
}

#[test]
fn the_stored_profile_and_memories_are_what_a_session_gets() {
    let fixture = fixture();
    let v = fixture.vectors.iter().find(|v| !v.out.included_ids.is_empty() && !v.block.withheld).expect("a vector");
    let (profiles, memories) = (Arc::new(FakeUserProfileStore::default()), Arc::new(FakeUserMemoryStore::default()));
    let blocks = ProfileBlocks::new(profiles.clone(), memories.clone());
    let input = ProfileBlockInput {
        kind: &v.kind,
        project: v.opts.project.as_deref(),
        known_lines: &v.opts.known_lines,
        search_tool_name: v.opts.search_tool_name.as_deref(),
    };

    // Nothing saved: the stock preferences.
    let stock: ProfileBlock = blocks.block(&input);
    assert_eq!(stock.text, DEFAULT_USER_PREFERENCES);
    assert!(stock.empty && !stock.withheld);

    profiles.put(v.profile.clone()).expect("put");
    for memory in &v.memories {
        memories.put(memory.clone()).expect("put");
    }
    let block = blocks.block(&input);
    assert_eq!(block.text, v.out.text);
    assert_eq!(block.included_ids, v.out.included_ids);
    assert_eq!(block.budget_tokens, v.profile.budget_tokens);
}
