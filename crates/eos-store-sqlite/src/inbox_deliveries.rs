//! `inbox_deliveries`, and `inbox_halt`, which every claim of a delivery
//! reads.

use eos_core::Error;
use eos_core::store::{DeliveryRepo, HaltRepo, StoredDelivery, StoredHalt};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, wire_word, word};

const DELIVERY_COLUMNS: &str = "id, item_id, run_id, routine_id, channel, action, target_ref, target, body, \
                                body_hash, class, mode, state, send_at, attempts, next_attempt_at, last_error_kind, \
                                partial, receipt, sent_at, undo_until, undone_at, approved_at, created_at, updated_at";

fn delivery(r: &rusqlite::Row<'_>) -> Result<StoredDelivery, Error> {
    let read = || -> rusqlite::Result<StoredDelivery> {
        Ok(StoredDelivery {
            id: r.get(0)?,
            item_id: r.get(1)?,
            run_id: r.get(2)?,
            routine_id: r.get(3)?,
            channel: r.get(4)?,
            action: r.get(5)?,
            target_ref: r.get(6)?,
            target: r.get(7)?,
            body: r.get(8)?,
            body_hash: r.get(9)?,
            class: wire_word(r, 10)?,
            mode: r.get(11)?,
            state: r.get(12)?,
            send_at: r.get(13)?,
            attempts: r.get(14)?,
            next_attempt_at: r.get(15)?,
            last_error_kind: r.get(16)?,
            partial: r.get(17)?,
            receipt: r.get(18)?,
            sent_at: r.get(19)?,
            undo_until: r.get(20)?,
            undone_at: r.get(21)?,
            approved_at: r.get(22)?,
            created_at: r.get(23)?,
            updated_at: r.get(24)?,
        })
    };
    read().map_err(failed)
}

impl DeliveryRepo for SqliteTx<'_> {
    fn insert(&self, delivery: &StoredDelivery) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO inbox_deliveries ({DELIVERY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
                 ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)"
            ),
            params![
                delivery.id,
                delivery.item_id,
                delivery.run_id,
                delivery.routine_id,
                delivery.channel,
                delivery.action,
                delivery.target_ref,
                delivery.target,
                delivery.body,
                delivery.body_hash,
                word(&delivery.class)?,
                delivery.mode,
                delivery.state,
                delivery.send_at,
                delivery.attempts,
                delivery.next_attempt_at,
                delivery.last_error_kind,
                delivery.partial,
                delivery.receipt,
                delivery.sent_at,
                delivery.undo_until,
                delivery.undone_at,
                delivery.approved_at,
                delivery.created_at,
                delivery.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredDelivery>, Error> {
        self.row(&format!("SELECT {DELIVERY_COLUMNS} FROM inbox_deliveries WHERE id = ?1"), [id], delivery)
    }

    fn due(&self, state: &str, now: i64, limit: i64) -> Result<Vec<StoredDelivery>, Error> {
        self.rows(
            &format!(
                "SELECT {DELIVERY_COLUMNS} FROM inbox_deliveries WHERE state = ?1 AND next_attempt_at <= ?2 \
                 ORDER BY next_attempt_at, created_at, rowid LIMIT ?3"
            ),
            params![state, now, limit],
            delivery,
        )
    }
}

/// The id of the switch's one row.
const HALT_ROW: i64 = 1;

impl HaltRepo for SqliteTx<'_> {
    fn get(&self) -> Result<StoredHalt, Error> {
        let halt = self.row("SELECT \"on\", since, by, updated_at FROM inbox_halt WHERE id = ?1", [HALT_ROW], |r| {
            let read = || -> rusqlite::Result<StoredHalt> {
                Ok(StoredHalt { on: r.get(0)?, since: r.get(1)?, by: r.get(2)?, updated_at: r.get(3)? })
            };
            read().map_err(failed)
        })?;
        Ok(halt.unwrap_or_default())
    }

    fn put(&self, halt: &StoredHalt) -> Result<(), Error> {
        self.exec(
            "INSERT INTO inbox_halt (id, \"on\", since, by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (id) DO UPDATE SET \"on\" = excluded.\"on\", since = excluded.since, by = excluded.by, \
             updated_at = excluded.updated_at",
            params![HALT_ROW, halt.on, halt.since, halt.by, halt.updated_at],
        )
        .map(drop)
    }
}
