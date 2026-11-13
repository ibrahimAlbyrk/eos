//! `GET /api/profile/avatar`: the plain route answers the stored image as before; `?size=`
//! answers the small copy of the size that serves it, where the app can make one.

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::AvatarExt;
use eos_core::Error as CoreError;
use eos_core::store::{AvatarThumbnails, UserAvatar, UserAvatarStore};
use eos_mod_profile::{PendingCaps, PreviewContext, ProfileModule, ProfileStores};
use eos_profile::ProfileBlocks;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{
    FakeClock, FakeMemoryProvider, FakeUserAvatarStore, FakeUserMemoryStore, FakeUserProfileStore, SeqIds, TempStore,
};

const JPEG: [u8; 4] = [0xff, 0xd8, 0xff, 0xe0];

/// Answers `small <size>` and remembers the sizes asked for.
#[derive(Default)]
struct FakeThumbnails {
    asked: Mutex<Vec<u32>>,
}

impl AvatarThumbnails for FakeThumbnails {
    fn thumbnail(&self, size: u32) -> Result<Option<UserAvatar>, CoreError> {
        self.asked.lock().unwrap_or_else(PoisonError::into_inner).push(size);
        Ok(Some(UserAvatar { bytes: format!("small {size}").into_bytes(), ext: AvatarExt::Png }))
    }
}

struct Composed {
    runtime: Runtime,
    thumbnails: Arc<FakeThumbnails>,
    _temp: TempStore,
}

fn composed(with_thumbnails: bool) -> Composed {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let (profile, memories) = (Arc::new(FakeUserProfileStore::default()), Arc::new(FakeUserMemoryStore::default()));
    let avatars = Arc::new(FakeUserAvatarStore::default());
    avatars.write(&UserAvatar { bytes: JPEG.to_vec(), ext: AvatarExt::Jpeg }).expect("an avatar");
    let stores = ProfileStores { profile: profile.clone(), avatars, memories: memories.clone(), workers: temp.port() };
    let preview = PreviewContext {
        blocks: Arc::new(ProfileBlocks::new(profile, memories)),
        memory: Arc::new(FakeMemoryProvider::default()),
        data_home: temp.home.path().to_owned(),
        memory_injected: Arc::new(|| true),
        search_tool_name: "search_memory".into(),
    };
    let thumbnails = Arc::new(FakeThumbnails::default());
    let mut module = ProfileModule::new(stores, preview, PendingCaps::default(), clock, ids, kernel.bus.clone());
    if with_thumbnails {
        module = module.with_avatar_thumbnails(thumbnails.clone());
    }
    let runtime = Runtime::build(kernel, vec![Arc::new(module)], Arc::new(AllPluginsOn)).expect("composes");
    Composed { runtime, thumbnails, _temp: temp }
}

async fn get(c: &Composed, target: &str) -> (u16, Option<String>, Option<String>, Vec<u8>) {
    let res = c.runtime.router.handle(Request::new(Method::Get, target, Caller::UNTRUSTED)).await;
    let header = |name: &str| res.header_value(name).map(str::to_owned);
    let (content_type, cache) = (header("content-type"), header("cache-control"));
    (res.status, content_type, cache, res.body.collect().await.expect("a body").to_vec())
}

#[tokio::test]
async fn the_plain_route_answers_the_stored_image_and_a_size_its_small_copy() {
    let c = composed(true);
    let day = Some("public, max-age=86400".to_owned());
    let plain = get(&c, "/api/profile/avatar?v=3").await;
    assert_eq!(plain, (200, Some("image/jpeg".into()), day.clone(), JPEG.to_vec()));
    // Asked in device pixels; answered with the size that serves it.
    let small = get(&c, "/api/profile/avatar?v=3&size=40").await;
    assert_eq!(small, (200, Some("image/png".into()), day, b"small 48".to_vec()));
    assert_eq!(get(&c, "/api/profile/avatar?size=128").await.3, b"small 128");
    assert_eq!(get(&c, "/api/profile/avatar?size=4000").await.3, b"small 256");
    // A size that is not one is not asked for.
    for odd in ["", "0", "-5", "big", "1.5"] {
        assert_eq!(get(&c, &format!("/api/profile/avatar?size={odd}")).await.3, JPEG, "{odd}");
    }
    assert_eq!(*c.thumbnails.asked.lock().unwrap_or_else(PoisonError::into_inner), [48, 128, 256]);
}

#[tokio::test]
async fn without_small_copies_a_size_gets_the_stored_image() {
    let c = composed(false);
    assert_eq!(get(&c, "/api/profile/avatar?size=48").await.3, JPEG);
}
