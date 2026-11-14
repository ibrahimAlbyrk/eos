use std::sync::{Arc, Mutex};

use eos_core::store::{Announcement, Announcer, Store};
use eos_kit_sqlite::rusqlite::Connection;
use eos_kit_sqlite::{Db, Error, Options};
use eos_runtime::bus::Bus;
use eos_store_sqlite::{SqliteStore, StoreOptions};

use crate::home::TempHome;

/// Keeps what committed writes announced, in commit order.
#[derive(Debug, Default)]
pub struct Announced(Mutex<Vec<Announcement>>);

impl Announced {
    /// `(topic, payload as JSON text)` of everything announced so far.
    pub fn list(&self) -> Vec<(&'static str, String)> {
        let events = self.0.lock().expect("announced");
        events.iter().map(|e| (e.topic, String::from_utf8_lossy(&e.payload).into_owned())).collect()
    }

    pub fn topics(&self) -> Vec<&'static str> {
        self.0.lock().expect("announced").iter().map(|e| e.topic).collect()
    }
}

impl Announcer for Announced {
    fn announce(&self, events: Vec<Announcement>) {
        self.0.lock().expect("announced").extend(events);
    }
}

/// Keeps the announcements and publishes them, in commit order.
struct OnBus {
    kept: Arc<Announced>,
    bus: Bus,
}

impl Announcer for OnBus {
    fn announce(&self, events: Vec<Announcement>) {
        for event in &events {
            self.bus.publish_raw(event.topic, None, event.payload.clone().into());
        }
        self.kept.announce(events);
    }
}

/// The real store over a `state.db` with every migration applied, in its own
/// [`TempHome`]: the same writer thread, readers and SQL as the app's.
#[derive(Debug)]
pub struct TempStore {
    // Declared first: the database closes before its folder is removed.
    pub store: Arc<SqliteStore>,
    pub announced: Arc<Announced>,
    pub home: TempHome,
}

impl TempStore {
    pub fn new() -> Self {
        Self::in_home(TempHome::new())
    }

    /// Opens (and migrates) the database of an existing folder.
    pub fn in_home(home: TempHome) -> Self {
        Self::open(home, None)
    }

    fn open(home: TempHome, bus: Option<Bus>) -> Self {
        let (db, _) = Db::open(home.paths().state_db(), Options::default(), 0).expect("a migrated database");
        let announced = Arc::new(Announced::default());
        let announcer: Arc<dyn Announcer> = match bus {
            Some(bus) => Arc::new(OnBus { kept: announced.clone(), bus }),
            None => announced.clone(),
        };
        let store = Arc::new(SqliteStore::new(db, announcer, StoreOptions::default()));
        Self { store, announced, home }
    }

    /// [`seeded`](Self::seeded), with every write's announcements also
    /// published on `bus`, as in the app: for a test that reads events off
    /// the bus or a stream.
    pub fn seeded_on_bus(sandbox: &str, bus: &Bus) -> Self {
        let temp = Self::open(TempHome::new(), Some(bus.clone()));
        temp.exec(&crate::fixtures::seed_sql(sandbox));
        temp
    }

    /// With the invented rows of the wire fixtures; `sandbox` stands in for
    /// the folder of the seeded projects.
    pub fn seeded(sandbox: &str) -> Self {
        let temp = Self::new();
        temp.exec(&crate::fixtures::seed_sql(sandbox));
        temp
    }

    /// The store as features hold it.
    pub fn port(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    /// Runs SQL on the writer, outside a transaction (seed rows, a hand-made state).
    pub fn exec(&self, sql: &str) {
        let sql = sql.to_owned();
        let ran = self.store.db().maintain(move |conn: &Connection| conn.execute_batch(&sql).map_err(Error::from));
        ran.expect("the SQL runs");
    }

    /// The number a `SELECT count(*) …` (or any one-integer query) answers.
    pub fn count(&self, sql: &str) -> i64 {
        let sql = sql.to_owned();
        let read = self.store.db().maintain(move |conn: &Connection| {
            conn.query_row(&sql, [], |row| row.get::<_, i64>(0)).map_err(Error::from)
        });
        read.expect("the query runs")
    }
}

impl TempHome {
    /// A data folder whose `state.db` is migrated and holds the wire
    /// fixtures' invented rows, closed again: what the app finds when it
    /// starts after a crash (one seeded chat was left working).
    pub fn seeded(sandbox: &str) -> Self {
        Self::new().with_seed(sandbox)
    }

    /// [`seeded`](Self::seeded), for a folder that already exists.
    pub fn with_seed(self, sandbox: &str) -> Self {
        let TempStore { store, home, .. } = TempStore::in_home(self);
        let sql = crate::fixtures::seed_sql(sandbox);
        let seeded = store.db().maintain(move |conn: &Connection| conn.execute_batch(&sql).map_err(Error::from));
        seeded.expect("the seed applies");
        drop(store);
        home
    }
}

impl Default for TempStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seeded_store_holds_the_fixture_rows() {
        let temp = TempStore::seeded("/sandbox");
        let workers = temp.store.read_blocking(|tx| tx.workers().list_all()).expect("reads");
        assert_eq!(workers.len(), 8);
        assert_eq!(workers[0].id, "w-BUSY", "newest first");
        assert!(temp.announced.list().is_empty());
    }
}
