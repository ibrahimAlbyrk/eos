//! User profile rules (`core/src/domain/user-profile.ts`): the empty profile,
//! applying a patch, and whether a profile says anything an agent should hear
//! (an empty one renders the stock preferences, so a user who never opens
//! Profile gets the same prompts as before profiles existed).

use eos_contracts::{
    AvatarExt, PROFILE_BUDGET_DEFAULT, UserProfile, UserProfileIdentity, UserProfileLanguage, UserProfilePatch,
    UserProfileSharing, UserProfileStyle, UserProfileWork, default_dreaming,
};

use crate::text::js_trim;

/// The profile of a user who never saved one.
pub fn empty_user_profile() -> UserProfile {
    UserProfile {
        rev: 0,
        updated_at: 0.into(),
        identity: UserProfileIdentity {
            full_name: String::new(),
            call_name: String::new(),
            handle: String::new(),
            avatar: None,
        },
        language: UserProfileLanguage { chat: None, code: None },
        work: UserProfileWork { roles: Vec::new(), stack: Vec::new(), level: None },
        style: UserProfileStyle { replies: None, autonomy: None, when_unclear: None, commits: None },
        instructions: String::new(),
        sharing: UserProfileSharing { withhold_from: Vec::new() },
        budget_tokens: PROFILE_BUDGET_DEFAULT,
        onboarded_at: None,
        dreaming: default_dreaming(),
    }
}

/// True when nothing in the profile reaches a prompt. Handle and avatar are
/// display-only, so they do not count.
pub fn is_profile_empty(p: &UserProfile) -> bool {
    let unset = |language: &Option<eos_contracts::ProfileLanguage>| language.as_ref().is_none_or(|l| l.0.is_empty());
    js_trim(&p.identity.full_name).is_empty()
        && js_trim(&p.identity.call_name).is_empty()
        && unset(&p.language.chat)
        && unset(&p.language.code)
        && p.work.roles.is_empty()
        && p.work.stack.is_empty()
        && p.work.level.is_none()
        && p.style.replies.is_none()
        && p.style.autonomy.is_none()
        && p.style.when_unclear.is_none()
        && p.style.commits.is_none()
        && js_trim(&p.instructions).is_empty()
}

/// `cur` with `patch` applied: groups merge one level deep, leaves (arrays
/// included) replace, then names and lists are tidied. `rev` and `updatedAt`
/// are the service's to set.
pub fn apply_profile_patch(cur: &UserProfile, patch: &UserProfilePatch) -> UserProfile {
    let mut next = cur.clone();
    if let Some(identity) = &patch.identity {
        set(&mut next.identity.full_name, &identity.full_name);
        set(&mut next.identity.call_name, &identity.call_name);
        set(&mut next.identity.handle, &identity.handle);
    }
    if let Some(language) = &patch.language {
        set(&mut next.language.chat, &language.chat);
        set(&mut next.language.code, &language.code);
    }
    if let Some(work) = &patch.work {
        set(&mut next.work.roles, &work.roles);
        set(&mut next.work.stack, &work.stack);
        set(&mut next.work.level, &work.level);
    }
    if let Some(style) = &patch.style {
        set(&mut next.style.replies, &style.replies);
        set(&mut next.style.autonomy, &style.autonomy);
        set(&mut next.style.when_unclear, &style.when_unclear);
        set(&mut next.style.commits, &style.commits);
    }
    set(&mut next.instructions, &patch.instructions);
    if let Some(sharing) = &patch.sharing {
        set(&mut next.sharing.withhold_from, &sharing.withhold_from);
    }
    set(&mut next.budget_tokens, &patch.budget_tokens);
    set(&mut next.onboarded_at, &patch.onboarded_at);
    if let Some(dreaming) = &patch.dreaming {
        let d = &mut next.dreaming;
        set(&mut d.enabled, &dreaming.enabled);
        set(&mut d.schedule, &dreaming.schedule);
        set(&mut d.nightly_at, &dreaming.nightly_at);
        set(&mut d.away_minutes, &dreaming.away_minutes);
        set(&mut d.model, &dreaming.model);
        set(&mut d.max_chats, &dreaming.max_chats);
        set(&mut d.usage_ceiling, &dreaming.usage_ceiling);
        set(&mut d.excluded_projects, &dreaming.excluded_projects);
        set(&mut d.include_no_folder, &dreaming.include_no_folder);
        set(&mut d.morning_note, &dreaming.morning_note);
    }
    normalize(next)
}

fn set<T: Clone>(field: &mut T, patch: &Option<T>) {
    if let Some(value) = patch {
        *field = value.clone();
    }
}

/// Same content, ignoring `rev` and `updatedAt`: a save that changes nothing
/// must not bump the revision.
pub fn same_profile_content(a: &UserProfile, b: &UserProfile) -> bool {
    a.identity == b.identity
        && a.language == b.language
        && a.work == b.work
        && a.style == b.style
        && a.instructions == b.instructions
        && a.sharing == b.sharing
        && a.budget_tokens == b.budget_tokens
        && a.onboarded_at == b.onboarded_at
        && a.dreaming == b.dreaming
}

/// The image type from its first bytes. A declared content type is never trusted.
pub fn sniff_avatar_ext(bytes: &[u8]) -> Option<AvatarExt> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some(AvatarExt::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(AvatarExt::Jpeg)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(AvatarExt::Webp)
    } else {
        None
    }
}

fn normalize(mut p: UserProfile) -> UserProfile {
    p.identity.full_name = js_trim(&p.identity.full_name).to_owned();
    p.identity.call_name = js_trim(&p.identity.call_name).to_owned();
    let handle = js_trim(&p.identity.handle);
    p.identity.handle = handle.strip_prefix('@').unwrap_or(handle).to_owned();
    dedupe(&mut p.work.roles, |role| *role);
    p.work.stack = p.work.stack.iter().map(|s| js_trim(s).to_owned()).filter(|s| !s.is_empty()).collect();
    dedupe(&mut p.work.stack, |item| item.to_lowercase());
    dedupe(&mut p.sharing.withhold_from, String::clone);
    dedupe(&mut p.dreaming.excluded_projects, String::clone);
    p
}

/// Keeps the first of each key, in order.
fn dedupe<T, K: Eq + std::hash::Hash>(items: &mut Vec<T>, key: impl Fn(&T) -> K) {
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(key(item)));
}

#[cfg(test)]
mod tests {
    use eos_contracts::{
        Autonomy, CommitPolicy, ExpertiseLevel, Num, ProfileLanguage, ReplyStyle, UserProfilePatchIdentity,
        UserProfilePatchWork, WhenUnclear, WorkRole,
    };

    use super::*;

    fn ibrahim() -> UserProfile {
        let mut p = empty_user_profile();
        p.identity = UserProfileIdentity {
            full_name: "Ibrahim Albayrak".into(),
            call_name: "Ibrahim".into(),
            handle: "ibrahimalbyrk".into(),
            avatar: None,
        };
        p.language =
            UserProfileLanguage { chat: Some(ProfileLanguage("tr".into())), code: Some(ProfileLanguage("en".into())) };
        p.work = UserProfileWork {
            roles: vec![WorkRole::Engineering],
            stack: vec!["TypeScript".into(), "React".into()],
            level: Some(ExpertiseLevel::Expert),
        };
        p.style = UserProfileStyle {
            replies: Some(ReplyStyle::Terse),
            autonomy: Some(Autonomy::Balanced),
            when_unclear: Some(WhenUnclear::Ask),
            commits: Some(CommitPolicy::OnRequest),
        };
        p
    }

    fn empty_patch() -> UserProfilePatch {
        UserProfilePatch {
            identity: None,
            language: None,
            work: None,
            style: None,
            instructions: None,
            sharing: None,
            budget_tokens: None,
            onboarded_at: None,
            dreaming: None,
        }
    }

    #[test]
    fn an_untouched_profile_is_empty_and_handle_and_avatar_alone_do_not_count() {
        assert!(is_profile_empty(&empty_user_profile()));
        let mut shown = empty_user_profile();
        shown.identity.handle = "x".into();
        shown.identity.avatar = Some(AvatarExt::Png);
        assert!(is_profile_empty(&shown));
        let mut told = empty_user_profile();
        told.instructions = "Be brief.".into();
        assert!(!is_profile_empty(&told));
    }

    #[test]
    fn a_patch_merges_groups_replaces_leaves_and_normalizes() {
        let patch = UserProfilePatch {
            identity: Some(UserProfilePatchIdentity {
                full_name: None,
                call_name: Some("  Ibo ".into()),
                handle: Some("@ibo".into()),
            }),
            work: Some(UserProfilePatchWork {
                roles: None,
                stack: Some(vec!["Bun".into(), "bun".into(), " Node ".into()]),
                level: None,
            }),
            ..empty_patch()
        };
        let next = apply_profile_patch(&ibrahim(), &patch);
        assert_eq!(next.identity.full_name, "Ibrahim Albayrak");
        assert_eq!(next.identity.call_name, "Ibo");
        assert_eq!(next.identity.handle, "ibo");
        assert_eq!(next.work.stack, ["Bun", "Node"]);
        assert_eq!(next.work.roles, [WorkRole::Engineering]);
        assert_eq!(next.work.level, Some(ExpertiseLevel::Expert));
    }

    #[test]
    fn onboarded_at_can_be_cleared_with_null_and_absent_leaves_it() {
        let done =
            apply_profile_patch(&ibrahim(), &UserProfilePatch { onboarded_at: Some(Some(Num(5.0))), ..empty_patch() });
        assert_eq!(apply_profile_patch(&done, &empty_patch()).onboarded_at, Some(Num(5.0)));
        let cleared = apply_profile_patch(&done, &UserProfilePatch { onboarded_at: Some(None), ..empty_patch() });
        assert_eq!(cleared.onboarded_at, None);
    }

    #[test]
    fn same_content_ignores_rev_and_updated_at() {
        let mut a = ibrahim();
        a.rev = 3;
        a.updated_at = Num(9.0);
        let b = apply_profile_patch(&ibrahim(), &empty_patch());
        assert!(same_profile_content(&a, &b));
        let told = apply_profile_patch(&a, &UserProfilePatch { instructions: Some("x".into()), ..empty_patch() });
        assert!(!same_profile_content(&a, &told));
    }

    #[test]
    fn the_image_type_comes_from_its_first_bytes() {
        assert_eq!(sniff_avatar_ext(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), Some(AvatarExt::Png));
        assert_eq!(sniff_avatar_ext(&[0xff, 0xd8, 0xff, 0xe0]), Some(AvatarExt::Jpeg));
        assert_eq!(sniff_avatar_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some(AvatarExt::Webp));
        assert_eq!(sniff_avatar_ext(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_avatar_ext(b"not an image"), None);
        assert_eq!(sniff_avatar_ext(&[]), None);
    }
}
