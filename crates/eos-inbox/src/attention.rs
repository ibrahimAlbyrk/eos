//! Attention (03 §4.7, G29): when Needs you may take the user's attention.
//!
//! - An item that may interrupt does so once, at its first chance: a banner
//!   (`notification:fire`, routed to `eos:/needs/<id>`) and a push of the
//!   open count to the phone. At most [`INTERRUPTS_PER_HOUR`]; nothing in
//!   quiet hours or with `interrupts: none`, and only the urgent kinds with
//!   `interrupts: urgent`. An item that missed its chance folds into the
//!   next digest and never interrupts later.
//! - A digest is one banner of counts at each digest time and at the end of
//!   quiet hours, when anything waits.
//! - The Dock badge shows the open count.
//!
//! Banners and pushes carry counts and kinds, never an item's text. A push
//! that fails leaves the banners: they already left.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{AttentionSettings, Interrupts};
use eos_core::net::relay::{PhoneNotify, PhonePush, PushKind};
use eos_core::os::{DockBadge, TimeZone};
use eos_core::store::{ConfigSource, Outbox, Store, Tx};
use eos_core::{Clock, Error};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::time::{instant_of, wall_clock};
use serde_json::json;

/// The most items that interrupt in an hour (G29).
pub const INTERRUPTS_PER_HOUR: i64 = 6;
/// The kinds that still interrupt with `interrupts: urgent`.
pub const URGENT_KINDS: [ItemKind; 3] =
    [ItemKind::DeliveryProblem, ItemKind::RoutineAlert, ItemKind::CapabilityAttention];
/// The shell's banner topic.
pub const NOTIFICATION_FIRE: &str = "notification:fire";

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// What the notifier is built from.
pub struct NotifierParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// The user's clock, for quiet hours and digest times.
    pub zone: Arc<dyn TimeZone>,
    /// `config.json`'s `attention` section.
    pub config: Arc<dyn ConfigSource>,
    pub phone: Arc<dyn PhoneNotify>,
    pub badge: Arc<dyn DockBadge>,
}

impl std::fmt::Debug for NotifierParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotifierParts").finish_non_exhaustive()
    }
}

/// Where the notifier stands. In memory: after a restart items made since
/// the last digest time may interrupt, the older ones wait for the next digest.
#[derive(Debug, Clone, Copy)]
struct Mark {
    /// Items made from then on may still interrupt.
    since: i64,
    /// When the next digest is due.
    next_digest: i64,
}

/// Interrupts, digests and the badge.
#[derive(Clone)]
pub struct Notifier {
    parts: Arc<NotifierParts>,
    mark: Arc<Mutex<Mark>>,
}

impl std::fmt::Debug for Notifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Notifier").finish_non_exhaustive()
    }
}

impl Notifier {
    pub fn new(parts: NotifierParts) -> Self {
        let now = parts.clock.now_ms();
        let settings = &parts.config.current().attention;
        let (since, next_digest) =
            (last_digest(settings, parts.zone.as_ref(), now), next_digest(settings, parts.zone.as_ref(), now));
        Self { parts: Arc::new(parts), mark: Arc::new(Mutex::new(Mark { since, next_digest })) }
    }

    fn mark(&self) -> MutexGuard<'_, Mark> {
        // Two plain numbers: valid after any panic.
        self.mark.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The settings changed: the next digest is read again.
    pub fn settings_changed(&self) {
        let now = self.parts.clock.now_ms();
        let next = next_digest(&self.parts.config.current().attention, self.parts.zone.as_ref(), now);
        self.mark().next_digest = next;
    }

    /// Shows `open` on the Dock icon.
    pub fn badge(&self, open: i64) {
        let open = u32::try_from(open).unwrap_or(u32::MAX);
        self.parts.badge.set((open > 0).then_some(open));
    }

    /// Something changed in Needs you, or a digest may be due: the digest
    /// first when it is, then what may interrupt. When the next digest is due.
    /// One caller at a time: two passes at once could both send a digest.
    pub async fn pass(&self) -> Result<i64, Error> {
        let now = self.parts.clock.now_ms();
        let settings = self.parts.config.current().attention.clone();
        let due = self.mark().next_digest;
        let quiet = is_quiet(&settings, self.parts.zone.as_ref(), now);
        // A digest time inside quiet hours stays quiet: the one at their end counts it in.
        if now >= due && !quiet {
            let told = self.parts.store.write(move |tx, out| digest_in(tx, out, now)).await?;
            if told > 0 {
                tracing::info!(waiting = told, "a digest of what needs the user");
            }
        }
        if now >= due {
            let next = next_digest(&settings, self.parts.zone.as_ref(), now);
            *self.mark() = Mark { since: now, next_digest: next };
        }
        let since = self.mark().since;
        let interrupts = settings.interrupts;
        let (fired, seen, open) =
            self.parts.store.write(move |tx, out| interrupt_in(tx, out, now, since, interrupts, quiet)).await?;
        if let Some(seen) = seen {
            let mut mark = self.mark();
            mark.since = mark.since.max(seen + 1);
        }
        if fired > 0 {
            tracing::info!(fired, open, "items interrupted");
            let push = PhonePush { kind: PushKind::NeedsYou, count: u32::try_from(open).unwrap_or(u32::MAX) };
            if let Err(error) = self.parts.phone.push(push).await {
                tracing::info!(%error, "the phone was not woken; the banners stand");
            }
        }
        Ok(self.mark().next_digest)
    }
}

/// Fires what may interrupt now: how many fired, the newest item looked at,
/// and how many items are open.
fn interrupt_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    since: i64,
    interrupts: Interrupts,
    quiet: bool,
) -> Result<(usize, Option<i64>, i64), Error> {
    let items = tx.inbox_items();
    let waiting = items.unnotified(since)?;
    let seen = waiting.iter().map(|item| item.created_at).max();
    let open = items.open_count()?;
    if quiet || interrupts == Interrupts::None {
        return Ok((0, seen, open));
    }
    let mut room = (INTERRUPTS_PER_HOUR - items.notified_since(now - HOUR_MS)?).max(0);
    let mut fired = 0;
    for item in waiting {
        if room == 0 {
            break;
        }
        if interrupts == Interrupts::Urgent && !URGENT_KINDS.contains(&item.kind) {
            continue;
        }
        if !items.set_notified(&item.id, now)? {
            continue;
        }
        let banner = json!({
            "title": things_need_you(open),
            "body": kind_words(item.kind, 1),
            "workerId": "",
            "route": format!("eos:/needs/{}", item.id),
            "ts": now,
        });
        out.push(NOTIFICATION_FIRE, &banner);
        room -= 1;
        fired += 1;
    }
    Ok((fired, seen, open))
}

/// One banner counting what waits, when anything does; how many wait.
fn digest_in(tx: &dyn Tx, out: &mut Outbox, now: i64) -> Result<i64, Error> {
    let mut by_kind: BTreeMap<&'static str, (ItemKind, i64)> = BTreeMap::new();
    for count in tx.inbox_items().counts()? {
        if matches!(count.state, ItemState::Open | ItemState::Later) {
            by_kind.entry(count.kind.as_str()).or_insert((count.kind, 0)).1 += count.count;
        }
    }
    let total: i64 = by_kind.values().map(|(_, n)| n).sum();
    if total == 0 {
        return Ok(0);
    }
    let mut kinds: Vec<(ItemKind, i64)> = by_kind.into_values().collect();
    kinds.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    let body = kinds.iter().map(|(kind, n)| kind_words(*kind, *n)).collect::<Vec<_>>().join(", ");
    let banner = json!({
        "title": things_need_you(total),
        "body": body,
        "workerId": "",
        "route": "eos:/needs",
        "ts": now,
    });
    out.push(NOTIFICATION_FIRE, &banner);
    Ok(total)
}

fn things_need_you(n: i64) -> String {
    if n == 1 { "1 thing needs you".to_owned() } else { format!("{n} things need you") }
}

/// `2 drafts`, `1 question`: a count and its kind.
fn kind_words(kind: ItemKind, n: i64) -> String {
    let (one, many) = match kind {
        ItemKind::Draft => ("draft", "drafts"),
        ItemKind::RunStart => ("run to start", "runs to start"),
        ItemKind::Question => ("question", "questions"),
        ItemKind::Permission => ("permission", "permissions"),
        ItemKind::CapabilityInstall => ("capability to install", "capabilities to install"),
        ItemKind::CapabilityAttention => ("capability to look at", "capabilities to look at"),
        ItemKind::AboutYou => ("note about you", "notes about you"),
        ItemKind::RoutineAlert => ("routine alert", "routine alerts"),
        ItemKind::FreedomOffer => ("offer", "offers"),
        ItemKind::ConfirmChange => ("change to confirm", "changes to confirm"),
        ItemKind::DeliveryProblem => ("send that failed", "sends that failed"),
        ItemKind::Suggestion => ("suggestion", "suggestions"),
        ItemKind::Notice => ("notice", "notices"),
    };
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Minutes after midnight of `HH:MM`.
fn minutes(at: &str) -> Option<i64> {
    let (h, m) = at.split_once(':')?;
    let (h, m) = (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?);
    ((0..24).contains(&h) && (0..60).contains(&m)).then_some(h * 60 + m)
}

fn offset_at(zone: &dyn TimeZone) -> impl Fn(i64) -> i32 + '_ {
    move |at| zone.offset_minutes_at(at)
}

/// Whether `now` falls in quiet hours on the user's clock. A window whose
/// end comes before its start runs over midnight.
fn is_quiet(settings: &AttentionSettings, zone: &dyn TimeZone, now: i64) -> bool {
    let (Some(from), Some(to)) = (minutes(&settings.quiet_from), minutes(&settings.quiet_to)) else { return false };
    if !settings.quiet_on || from == to {
        return false;
    }
    let minute = wall_clock(now, &offset_at(zone)).rem_euclid(DAY_MS) / MINUTE_MS;
    if from < to { (from..to).contains(&minute) } else { minute >= from || minute < to }
}

/// The digest times and ends of quiet hours from the day before `now` to
/// the day after.
fn digest_slots(settings: &AttentionSettings, zone: &dyn TimeZone, now: i64) -> Vec<i64> {
    let offset = offset_at(zone);
    let wall = wall_clock(now, &offset);
    let midnight = wall - wall.rem_euclid(DAY_MS);
    let quiet_end = settings.quiet_on.then_some(settings.quiet_to.as_str());
    settings
        .digests
        .iter()
        .map(String::as_str)
        .chain(quiet_end)
        .filter_map(minutes)
        .flat_map(|at| (-1..2).map(move |day| midnight + day * DAY_MS + at * MINUTE_MS))
        .map(|wall| instant_of(wall, &offset))
        .collect()
}

/// The first digest after `now`: a digest time, or the end of quiet hours.
/// A day ahead when none is set, so the caller still wakes.
fn next_digest(settings: &AttentionSettings, zone: &dyn TimeZone, now: i64) -> i64 {
    digest_slots(settings, zone, now).into_iter().filter(|at| *at > now).min().unwrap_or(now + DAY_MS)
}

/// The last digest at or before `now`; a day back when none is set.
fn last_digest(settings: &AttentionSettings, zone: &dyn TimeZone, now: i64) -> i64 {
    digest_slots(settings, zone, now).into_iter().filter(|at| *at <= now).max().unwrap_or(now - DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(i32);

    impl TimeZone for Fixed {
        fn name(&self) -> String {
            "Fixed".into()
        }
        fn offset_minutes_at(&self, _epoch_ms: i64) -> i32 {
            self.0
        }
    }

    fn settings() -> AttentionSettings {
        AttentionSettings {
            quiet_on: true,
            quiet_from: "22:00".into(),
            quiet_to: "08:00".into(),
            digests: vec!["09:00".into(), "17:00".into()],
            interrupts: Interrupts::All,
        }
    }

    /// 2025-01-01 at `h:m` UTC.
    fn at(h: i64, m: i64) -> i64 {
        1_735_689_600_000 + h * HOUR_MS + m * MINUTE_MS
    }

    #[test]
    fn quiet_hours_run_over_midnight_on_the_user_s_clock() {
        let utc = Fixed(0);
        assert!(is_quiet(&settings(), &utc, at(23, 0)));
        assert!(is_quiet(&settings(), &utc, at(7, 59)));
        assert!(!is_quiet(&settings(), &utc, at(8, 0)));
        assert!(is_quiet(&settings(), &Fixed(180), at(23, 0)), "23:00 UTC is 02:00 at +3");
        assert!(!is_quiet(&settings(), &Fixed(180), at(18, 0)), "21:00 at +3");
        let off = AttentionSettings { quiet_on: false, ..settings() };
        assert!(!is_quiet(&off, &utc, at(23, 0)));
    }

    #[test]
    fn the_next_digest_is_the_end_of_quiet_hours_or_a_digest_time() {
        let utc = Fixed(0);
        assert_eq!(next_digest(&settings(), &utc, at(23, 0)), at(32, 0), "08:00 the next day");
        assert_eq!(next_digest(&settings(), &utc, at(8, 0)), at(9, 0));
        assert_eq!(next_digest(&settings(), &utc, at(12, 0)), at(17, 0));
        assert_eq!(next_digest(&settings(), &Fixed(60), at(12, 0)), at(16, 0), "17:00 at +1");
        let none = AttentionSettings { quiet_on: false, digests: Vec::new(), ..settings() };
        assert_eq!(next_digest(&none, &utc, at(12, 0)), at(36, 0));
    }

    #[test]
    fn the_last_digest_is_the_latest_one_at_or_before_now() {
        let utc = Fixed(0);
        assert_eq!(last_digest(&settings(), &utc, at(12, 0)), at(9, 0));
        assert_eq!(last_digest(&settings(), &utc, at(7, 0)), at(-7, 0), "17:00 the day before");
        assert_eq!(last_digest(&settings(), &utc, at(8, 0)), at(8, 0), "the end of quiet hours");
        let none = AttentionSettings { quiet_on: false, digests: Vec::new(), ..settings() };
        assert_eq!(last_digest(&none, &utc, at(12, 0)), at(-12, 0));
    }

    #[test]
    fn counts_read_as_words() {
        assert_eq!(things_need_you(1), "1 thing needs you");
        assert_eq!(kind_words(ItemKind::Draft, 2), "2 drafts");
        assert_eq!(kind_words(ItemKind::Question, 1), "1 question");
    }
}
