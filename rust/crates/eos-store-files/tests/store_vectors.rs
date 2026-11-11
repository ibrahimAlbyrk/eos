//! The file stores against today's: every page, memory and profile in
//! `tests/fixtures/store-vectors.json` (written by `scripts/gen-store-vectors.mjs`
//! from the TypeScript stores) must be written byte for byte as the
//! TypeScript wrote it, and every file must read back as the TypeScript read it.

use eos_contracts::{Page, UserMemory, UserProfile};
use eos_store_files::memories::{parse_user_memory, serialize_user_memory};
use eos_store_files::pages::{parse_page, serialize_page};
use eos_store_files::profile::{parse_user_profile, serialize_user_profile};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageVector {
    page: Page,
    file: String,
    read_back: Page,
}

#[derive(Deserialize)]
struct RawPage {
    raw: String,
    page: Option<Page>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryVector {
    memory: UserMemory,
    file: String,
    read_back: UserMemory,
}

#[derive(Deserialize)]
struct RawMemory {
    raw: String,
    memory: Option<UserMemory>,
}

#[derive(Deserialize)]
struct ProfileVector {
    profile: UserProfile,
    file: String,
}

#[derive(Deserialize)]
struct RawProfile {
    raw: String,
    profile: Option<UserProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    pages: Vec<PageVector>,
    raw_pages: Vec<RawPage>,
    memories: Vec<MemoryVector>,
    raw_memories: Vec<RawMemory>,
    profiles: Vec<ProfileVector>,
    raw_profiles: Vec<RawProfile>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/store-vectors.json")).expect("fixture")
}

#[test]
fn pages_are_written_and_read_as_today() {
    let fixture = fixture();
    assert!(fixture.pages.len() >= 200 && fixture.raw_pages.len() >= 30);
    for v in &fixture.pages {
        assert_eq!(serialize_page(&v.page).expect("serializes"), v.file, "{:?}", v.page);
        assert_eq!(parse_page(&v.file).as_ref(), Some(&v.read_back), "reading {:?}", v.file);
    }
    for v in &fixture.raw_pages {
        assert_eq!(parse_page(&v.raw), v.page, "reading {:?}", v.raw);
    }
}

#[test]
fn memories_are_written_and_read_as_today() {
    let fixture = fixture();
    assert!(fixture.memories.len() >= 200 && fixture.raw_memories.len() >= 20);
    for v in &fixture.memories {
        assert_eq!(serialize_user_memory(&v.memory).expect("serializes"), v.file, "{:?}", v.memory);
        assert_eq!(parse_user_memory(&v.file).as_ref(), Some(&v.read_back), "reading {:?}", v.file);
    }
    for v in &fixture.raw_memories {
        assert_eq!(parse_user_memory(&v.raw), v.memory, "reading {:?}", v.raw);
    }
}

#[test]
fn the_profile_is_written_and_read_as_today() {
    let fixture = fixture();
    assert!(fixture.profiles.len() >= 60 && fixture.raw_profiles.len() >= 10);
    for v in &fixture.profiles {
        assert_eq!(serialize_user_profile(&v.profile).expect("serializes"), v.file, "{:?}", v.profile);
        assert_eq!(parse_user_profile(&v.file).as_ref(), Some(&v.profile));
    }
    for v in &fixture.raw_profiles {
        assert_eq!(parse_user_profile(&v.raw), v.profile, "reading {:?}", v.raw);
    }
}
