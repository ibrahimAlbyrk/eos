//! Sample data of every Eos area for a dev run and the dashboard's screens,
//! beside the sample routines of [`crate::routine_seed`]: signals and what
//! became of them, Needs-you items of every kind, notes, a mail routine
//! whose View surface has three issues, and capabilities in each state. Ids
//! and times are fixed, so a second [`seed`] finds them and writes nothing.

mod capabilities;
mod inbox;
mod memory;
mod signals;
mod surfaces;

use eos_core::Error;
use eos_core::store::{Store, Tx};

pub use surfaces::{MAIL_ISSUES, MAIL_SURFACE, MORNING_MAIL};

/// Writes the sample routines, then every other area's samples in one
/// write. False when all of them were there already.
pub async fn seed(store: &dyn Store) -> Result<bool, Error> {
    let routines = crate::routine_seed::seed(store).await?;
    let areas = store.write(|tx, _| write(tx)).await?;
    Ok(routines || areas)
}

fn write(tx: &dyn Tx) -> Result<bool, Error> {
    if tx.surfaces().find(MAIL_SURFACE)?.is_some() {
        return Ok(false);
    }
    surfaces::write(tx)?;
    signals::write(tx)?;
    inbox::write(tx)?;
    memory::write(tx)?;
    capabilities::write(tx)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_area_is_seeded_once() {
        let temp = crate::TempStore::new();
        assert!(seed(temp.port().as_ref()).await.expect("seeds"));
        assert!(!seed(temp.port().as_ref()).await.expect("seeds again"), "its ids are there");
        for (table, at_least) in [
            ("routines", 4),
            ("signals", 6),
            ("signal_routes", 6),
            ("inbox_items", 13),
            ("mem_notes", 4),
            ("surface_defs", 1),
            ("surface_issues", 3),
            ("capability_installs", 7),
        ] {
            let n = temp.count(&format!("SELECT count(*) FROM {table}"));
            assert!(n >= at_least, "{table}: {n}");
        }
        let kinds = temp.count("SELECT count(DISTINCT kind) FROM inbox_items");
        assert_eq!(kinds, eos_domain::inbox::ItemKind::ALL.len() as i64, "an item of every kind");
        let states = temp.count("SELECT count(DISTINCT state) FROM capability_installs");
        assert_eq!(states, eos_domain::capability::health::HealthState::ALL.len() as i64, "every state");
    }
}
