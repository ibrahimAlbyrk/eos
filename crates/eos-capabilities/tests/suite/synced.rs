//! A capability's definition on the user's other computers: it arrives
//! `available` with its package and settings and never a secret, runs
//! nothing until the user installs it there, and then stands where that
//! computer's secrets put it.

use eos_core::capability::{CapabilityRegistry, CapabilitySecrets};
use eos_domain::capability::health::HealthState;

use crate::rig::{Setup, notes, rig};

#[tokio::test]
async fn a_definition_arrives_available_without_secrets_and_installs_here_on_the_users_word() {
    let (air, pro) = (rig(Setup::default()).await, rig(Setup::default()).await);
    air.install(&notes("1.0.0"), "h-1").await;
    air.service.set_settings("notes-db", vec![("folder".into(), "/Users/sam/Notes".into())]).await.expect("set");

    let items = air.service.synced_list().await.expect("lists");
    assert_eq!(items.len(), 1);
    let text = items[0].data.to_string();
    assert!(!text.contains("nk_planted_key_2"), "a secret never travels");
    assert!(text.contains("/Users/sam/Notes") && text.contains("capability.toml"), "settings and the package do");

    pro.service.synced_apply("notes-db", &items[0].data).await.expect("applies");
    let arrived = pro.service.get("notes-db").await.expect("reads").expect("there");
    assert_eq!((arrived.origin.as_str(), arrived.health.state), ("synced", HealthState::Available));
    assert!(pro.files.dir("notes-db", "1.0.0").join("README.md").is_file(), "its files are here");
    assert_eq!(
        pro.service.synced_get("notes-db").await.expect("reads"),
        Some(items[0].clone()).map(|mut item| {
            item.updated_at = Some(1_000.0);
            item
        })
    );

    // No key on this computer yet: installing here asks for it.
    pro.service.install_here("notes-db").await.expect("installs");
    let here = pro.service.get("notes-db").await.expect("reads").expect("there");
    assert_eq!(here.health.state, HealthState::NeedsSetup, "{here:?}");
    assert!(pro.service.install_here("notes-db").await.is_err(), "once");

    // Installed on both, a change there brings only its settings.
    pro.secrets.write("notes-db", "api_key", "nk_other".to_owned().into()).await.expect("the key");
    let mut changed = items[0].data.clone();
    changed["settings"] = serde_json::json!({"folder": "/Users/sam/Elsewhere"});
    pro.service.synced_apply("notes-db", &changed).await.expect("applies");
    let kept = pro.service.get("notes-db").await.expect("reads").expect("there");
    assert_eq!(kept.health.state, HealthState::NeedsSetup, "its state is this computer's");
    pro.service.synced_remove("notes-db").await.expect("removes");
    assert!(pro.service.get("notes-db").await.expect("reads").is_some(), "one installed here stays");
}

#[tokio::test]
async fn files_that_do_not_hash_as_they_came_are_refused() {
    let (air, pro) = (rig(Setup::default()).await, rig(Setup::default()).await);
    air.install(&notes("1.0.0"), "h-1").await;
    let items = air.service.synced_list().await.expect("lists");
    pro.service.synced_apply("notes-db", &items[0].data).await.expect("applies");
    pro.files.tamper("notes-db", "1.0.0", "h-other");
    assert!(pro.service.install_here("notes-db").await.is_err(), "edited after it came");
    assert!(pro.service.synced_apply("other-id", &items[0].data).await.is_err(), "of another capability");
}
