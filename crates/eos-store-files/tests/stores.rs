//! The stores over real folders: what the TypeScript store tests pin.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use eos_contracts::{
    AvatarExt, Num, Page, PageAuthor, PageAuthorKind, PageId, UserMemory, UserMemoryCategory, UserMemoryId,
    UserMemoryScope, UserMemoryScopeProject, UserMemorySource, UserMemorySourceAgent, UserMemoryStatus, UserMemoryTier,
};
use eos_core::Error;
use eos_core::store::{PageStore, UserAvatar, UserAvatarStore, UserMemoryStore, UserProfileStore};
use eos_domain::user_profile::empty_user_profile;
use eos_store_files::memories::{FileUserMemoryStore, serialize_user_memory};
use eos_store_files::pages::{FilePageStore, parse_page, serialize_page};
use eos_store_files::profile::{FileUserAvatarStore, FileUserProfileStore};
use eos_testkit::FakeClock;

fn clock() -> Arc<FakeClock> {
    // 2026-01-01T09:30:00.125Z
    Arc::new(FakeClock::at(1_767_259_800_125))
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).expect("list").filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    names.sort();
    names
}

fn page() -> Page {
    Page {
        id: PageId("pg-abc12345".into()),
        title: "Stance: notes — \"quoted\"".into(),
        body: "---\nnot frontmatter\n---\n\n- [ ] task\n".into(),
        project: Some("/Users/me/dear-souls".into()),
        agent_id: None,
        rev: 3,
        created_at: Num(1.0),
        updated_at: Num(2.0),
        updated_by: PageAuthor {
            kind: PageAuthorKind::Agent,
            agent_id: Some("w-1".into()),
            name: Some("Stance IK".into()),
        },
    }
}

fn memory() -> UserMemory {
    UserMemory {
        id: UserMemoryId("um-abc12345".into()),
        text: "Never run `eos build` while developing — it kills running workers.".into(),
        category: UserMemoryCategory::WorkStyle,
        domain: None,
        scope: UserMemoryScope::Project(UserMemoryScopeProject { path: "/Users/me/eos".into() }),
        tier: UserMemoryTier::OnDemand,
        status: UserMemoryStatus::Suggested,
        source: UserMemorySource::Agent(UserMemorySourceAgent {
            agent_id: "w-1".into(),
            agent_name: "stream".into(),
            why: Some("said it twice".into()),
        }),
        proposal: None,
        rev: 2,
        created_at: Num(1.0),
        updated_at: Num(2.0),
    }
}

#[test]
fn a_page_round_trips_through_its_file_body_verbatim() {
    let file = serialize_page(&page()).expect("serializes");
    assert_eq!(parse_page(&file), Some(page()));
    assert!(file.ends_with("---\n---\nnot frontmatter\n---\n\n- [ ] task\n"), "{file}");
}

#[test]
fn pages_persist_reload_and_are_deleted_into_the_trash() {
    let dir = tempfile::tempdir().expect("dir");
    let store = FilePageStore::open(dir.path(), clock());
    store.put(page()).expect("put");
    assert!(fs::read_to_string(dir.path().join("pg-abc12345.md")).expect("read").contains("- [ ] task"));

    let reloaded = FilePageStore::open(dir.path(), clock());
    assert_eq!(reloaded.get("pg-abc12345").as_deref(), Some(&page()));
    assert!(reloaded.remove("pg-abc12345").expect("remove"));
    assert!(!reloaded.remove("pg-abc12345").expect("gone"));
    assert!(reloaded.get("pg-abc12345").is_none());
    assert_eq!(names(&dir.path().join(".trash")), ["pg-abc12345.2026-01-01T09-30-00-125.md"]);
    assert!(FilePageStore::open(dir.path(), clock()).list().is_empty());
}

#[test]
fn unreadable_page_files_are_skipped_and_a_bad_page_is_refused() {
    let dir = tempfile::tempdir().expect("dir");
    fs::write(dir.path().join("pg-zzzzzzzz.md"), "no frontmatter").expect("write");
    fs::write(dir.path().join("pg-other000.md"), serialize_page(&page()).expect("serializes")).expect("write");
    let store = FilePageStore::open(dir.path(), clock());
    assert!(store.list().is_empty());

    let escape = Page { id: PageId("../escape".into()), ..page() };
    assert!(matches!(store.put(escape), Err(Error::Validation(_))));
    let long = Page { title: "x".repeat(201), ..page() };
    let refused = store.put(long).expect_err("too long");
    assert_eq!(refused.to_string(), "invalid request: title: String must contain at most 200 character(s)");
    assert_eq!(names(dir.path()), ["pg-other000.md", "pg-zzzzzzzz.md"], "nothing was written");
}

#[test]
fn memories_persist_reload_and_are_deleted_into_the_trash() {
    let file = serialize_user_memory(&memory()).expect("serializes");
    assert!(file.contains("\n---\nNever run `eos build`"), "{file}");

    let dir = tempfile::tempdir().expect("dir");
    FileUserMemoryStore::open(dir.path(), clock()).put(memory()).expect("put");
    let reloaded = FileUserMemoryStore::open(dir.path(), clock());
    assert_eq!(reloaded.get("um-abc12345").as_deref(), Some(&memory()));
    assert!(reloaded.remove("um-abc12345").expect("remove"));
    assert!(!reloaded.remove("um-abc12345").expect("gone"));
    assert_eq!(names(dir.path()), [".trash"]);
    assert_eq!(names(&dir.path().join(".trash")).len(), 1);
}

#[test]
fn memory_files_that_do_not_parse_or_match_their_name_are_skipped() {
    let dir = tempfile::tempdir().expect("dir");
    fs::write(dir.path().join("um-broken000.md"), "no frontmatter").expect("write");
    fs::write(dir.path().join("um-other0000.md"), serialize_user_memory(&memory()).expect("serializes"))
        .expect("write");
    assert!(FileUserMemoryStore::open(dir.path(), clock()).list().is_empty());
    assert_eq!(fs::read_to_string(dir.path().join("um-broken000.md")).expect("kept"), "no frontmatter");
}

#[test]
fn the_profile_is_none_until_saved_then_round_trips_across_instances() {
    let dir = tempfile::tempdir().expect("dir");
    assert!(FileUserProfileStore::open(dir.path()).get().is_none());
    let mut profile = empty_user_profile();
    profile.rev = 2;
    profile.instructions = "Use pnpm.".into();
    let store = FileUserProfileStore::open(dir.path().join("profile"));
    store.put(profile.clone()).expect("put");
    assert_eq!(store.get().as_deref(), Some(&profile));
    assert_eq!(FileUserProfileStore::open(dir.path().join("profile")).get().as_deref(), Some(&profile));
}

#[test]
fn an_invalid_profile_file_reads_as_never_saved_and_an_invalid_profile_is_refused() {
    let dir = tempfile::tempdir().expect("dir");
    fs::write(dir.path().join("profile.json"), "{ not json").expect("write");
    assert!(FileUserProfileStore::open(dir.path()).get().is_none());
    fs::write(dir.path().join("profile.json"), r#"{"rev":"x"}"#).expect("write");
    let store = FileUserProfileStore::open(dir.path());
    assert!(store.get().is_none());

    let mut small = empty_user_profile();
    small.budget_tokens = 1;
    assert!(matches!(store.put(small), Err(Error::Validation(_))));
    assert_eq!(fs::read_to_string(dir.path().join("profile.json")).expect("kept"), r#"{"rev":"x"}"#);
}

#[test]
fn one_avatar_at_a_time_whatever_its_type() {
    let dir = tempfile::tempdir().expect("dir");
    let store = FileUserAvatarStore::new(dir.path().join("profile"));
    assert_eq!(store.read().expect("read"), None);
    store.remove().expect("nothing to remove");
    store.write(&UserAvatar { bytes: vec![1, 2], ext: AvatarExt::Png }).expect("write");
    store.write(&UserAvatar { bytes: vec![3], ext: AvatarExt::Webp }).expect("write");
    assert_eq!(names(&dir.path().join("profile")), ["avatar.webp"]);
    assert_eq!(store.read().expect("read"), Some(UserAvatar { bytes: vec![3], ext: AvatarExt::Webp }));
    store.remove().expect("remove");
    assert_eq!(store.read().expect("read"), None);
}

/// Every page, memory and the profile of a real data folder loads and is
/// written back byte for byte. Runs when `EOS_REAL_HOME` names a private copy
/// of a data folder; reads only, and prints counts, never content.
#[test]
fn a_real_data_folder_loads_and_round_trips_unchanged() {
    let Some(home) = std::env::var_os("EOS_REAL_HOME") else { return };
    let home = Path::new(&home);
    let md_files = |dir: &Path| -> Vec<std::path::PathBuf> {
        let files = fs::read_dir(dir).expect("the folder").filter_map(|e| Some(e.ok()?.path()));
        files.filter(|p| p.extension().is_some_and(|ext| ext == "md")).collect()
    };

    let pages = md_files(&home.join("pages"));
    for path in &pages {
        let raw = fs::read_to_string(path).expect("utf-8");
        let name = path.file_name().expect("name").to_string_lossy().into_owned();
        let page = parse_page(&raw).unwrap_or_else(|| panic!("{name} does not load"));
        assert_eq!(format!("{}.md", page.id.0), name);
        assert!(serialize_page(&page).expect("serializes") == raw, "{name} does not round-trip");
    }
    assert_eq!(FilePageStore::open(home.join("pages"), clock()).list().len(), pages.len());

    let memories = md_files(&home.join("profile/memories"));
    for path in &memories {
        let raw = fs::read_to_string(path).expect("utf-8");
        let name = path.file_name().expect("name").to_string_lossy().into_owned();
        let memory =
            eos_store_files::memories::parse_user_memory(&raw).unwrap_or_else(|| panic!("{name} does not load"));
        assert_eq!(format!("{}.md", memory.id.0), name);
        assert!(serialize_user_memory(&memory).expect("serializes") == raw, "{name} does not round-trip");
    }
    assert_eq!(FileUserMemoryStore::open(home.join("profile/memories"), clock()).list().len(), memories.len());

    let raw = fs::read_to_string(home.join("profile/profile.json")).expect("profile.json");
    let profile = eos_store_files::profile::parse_user_profile(&raw).expect("the profile loads");
    assert!(eos_store_files::profile::serialize_user_profile(&profile).expect("serializes") == raw);
    assert!(FileUserAvatarStore::new(home.join("profile")).read().expect("read").is_some());
    println!("round-tripped {} pages, {} memories, the profile", pages.len(), memories.len());
}

mod surface_images {
    use std::io::Cursor;
    use std::sync::Arc;

    use eos_core::surface::{ImageFailure, ImageSource, SurfaceImages};
    use eos_store_files::surface_images::FileSurfaceImages;
    use eos_testkit::FakeMedia;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

    fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Vec::new();
        image.write_to(&mut Cursor::new(&mut out), format).expect("encodes");
        out
    }

    /// A JPEG with an EXIF block that names a place.
    fn photo_with_location() -> &'static [u8] {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2400, 1200, Rgb([200, 120, 40])));
        let jpeg = encoded(&image, ImageFormat::Jpeg);
        let payload = b"Exif\0\0GPS-41.0082N-28.9784E";
        let len = u16::try_from(payload.len() + 2).expect("short");
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&jpeg[2..]);
        Box::leak(out.into_boxed_slice())
    }

    fn store(dir: &std::path::Path, media: FakeMedia) -> FileSurfaceImages {
        FileSurfaceImages::new(dir.join("surfaces"), Arc::new(media))
    }

    #[tokio::test]
    async fn an_image_is_scaled_written_again_without_its_metadata_and_named_by_its_hash() {
        let dir = tempfile::tempdir().expect("temp dir");
        let media = FakeMedia::default().with("https://example.com/a.jpg", "image/jpeg", photo_with_location(), "a");
        let images = store(dir.path(), media);
        let image = images
            .intake("sf-1", ImageSource::Url("https://example.com/a.jpg".into()))
            .await
            .expect("the photo is taken in");
        assert_eq!((image.width, image.height, image.content_type.as_str()), (1600, 800, "image/jpeg"));
        let file = dir.path().join(format!("surfaces/sf-1/img/{}.jpg", image.hash));
        let written = std::fs::read(&file).expect("stored under its hash");
        assert!(!written.windows(3).any(|w| w == b"GPS"), "the location is gone");
        let again = images.intake("sf-1", ImageSource::Url("https://example.com/a.jpg".into())).await.expect("again");
        assert_eq!(again.hash, image.hash, "the same picture is stored once");
        let small = images.read("sf-1", &image.hash, Some(600)).await.expect("reads").expect("is there");
        let small = image::load_from_memory(&small.body).expect("decodes");
        assert_eq!(small.width(), 600);
        assert!(images.read("sf-1", "../../secret", None).await.expect("reads").is_none());
    }

    #[tokio::test]
    async fn transparency_stays_png_and_what_is_not_an_image_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");
        let clear = DynamicImage::ImageRgba8(RgbaImage::from_pixel(20, 10, Rgba([0, 0, 0, 0])));
        let png: &'static [u8] = Box::leak(encoded(&clear, ImageFormat::Png).into_boxed_slice());
        let bmp: &'static [u8] = b"BM\x46\0\0\0\0\0\0\0\x36\0\0\0\x28\0\0\0";
        let media = FakeMedia::default()
            .with("https://example.com/clear.png", "image/png", png, "p")
            .with("https://example.com/x.bmp", "image/bmp", bmp, "b")
            .with("https://example.com/page", "text/html", b"<html><script>alert(1)</script>", "h");
        let images = store(dir.path(), media);
        let image = images.intake("sf-1", ImageSource::Url("https://example.com/clear.png".into())).await.expect("png");
        assert_eq!(image.content_type, "image/png");
        for url in ["https://example.com/x.bmp", "https://example.com/page"] {
            let refused = images.intake("sf-1", ImageSource::Url(url.into())).await;
            assert_eq!(refused, Err(ImageFailure::NotAnImage), "{url}");
        }
        let gone = images.intake("sf-1", ImageSource::Url("https://example.com/none.png".into())).await;
        assert_eq!(gone, Err(ImageFailure::Unreachable));
    }

    #[tokio::test]
    async fn a_run_file_is_read_only_when_it_is_a_plain_file_and_collection_keeps_what_is_named() {
        let dir = tempfile::tempdir().expect("temp dir");
        let images = store(dir.path(), FakeMedia::default());
        let picture = DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([1, 2, 3])));
        let file = dir.path().join("chart.png");
        std::fs::write(&file, encoded(&picture, ImageFormat::Png)).expect("writes");
        let link = dir.path().join("link.png");
        std::os::unix::fs::symlink(&file, &link).expect("links");
        assert_eq!(images.intake("sf-1", ImageSource::RunFile(link)).await, Err(ImageFailure::Unreachable));
        let kept = images.intake("sf-1", ImageSource::RunFile(file)).await.expect("a plain file");
        let other = DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([9, 9, 9])));
        let other_file = dir.path().join("other.png");
        std::fs::write(&other_file, encoded(&other, ImageFormat::Png)).expect("writes");
        let dropped = images.intake("sf-1", ImageSource::RunFile(other_file)).await.expect("taken in");
        let freed = images.collect("sf-1", std::slice::from_ref(&kept.hash)).await.expect("collects");
        assert_eq!(freed, dropped.bytes);
        assert!(images.read("sf-1", &kept.hash, None).await.expect("reads").is_some());
        assert!(images.read("sf-1", &dropped.hash, None).await.expect("reads").is_none());
    }
}
