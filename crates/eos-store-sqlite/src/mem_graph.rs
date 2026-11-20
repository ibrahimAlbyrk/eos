//! `mem_hooks`, `mem_links` and `mem_credit`.

use eos_core::Error;
use eos_core::store::{MemCreditRepo, MemGraphRepo, StoredCredit, StoredHook, StoredLink};
use eos_domain::experience::HookKind;
use eos_domain::experience::state::Counters;
use eos_kit_sqlite::rusqlite::{self, params, params_from_iter};

use crate::mem_notes::placeholders;
use crate::tx::{SqliteTx, failed, known};

fn hook(r: &rusqlite::Row<'_>) -> Result<StoredHook, Error> {
    let read = || -> rusqlite::Result<StoredHook> {
        Ok(StoredHook {
            id: r.get(0)?,
            kind: known(r, 1, HookKind::parse)?,
            key: r.get(2)?,
            label: r.get(3)?,
            degree: r.get(4)?,
        })
    };
    read().map_err(failed)
}

fn link(r: &rusqlite::Row<'_>) -> Result<StoredLink, Error> {
    let read = || -> rusqlite::Result<StoredLink> {
        Ok(StoredLink {
            a: r.get(0)?,
            b: r.get(1)?,
            rel: r.get(2)?,
            weight: r.get(3)?,
            co_uses: r.get(4)?,
            updated_at: r.get(5)?,
        })
    };
    read().map_err(failed)
}

impl MemGraphRepo for SqliteTx<'_> {
    fn add_hook(&self, h: &StoredHook) -> Result<bool, Error> {
        let added = self.exec(
            "INSERT INTO mem_hooks (id, kind, key, label, degree) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
            params![h.id, h.kind.as_str(), h.key, h.label, h.degree],
        )?;
        Ok(added > 0)
    }

    fn hooks(&self, ids: &[String]) -> Result<Vec<StoredHook>, Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, kind, key, label, degree FROM mem_hooks WHERE id IN ({}) ORDER BY id",
            placeholders(1, ids.len())
        );
        self.rows(&sql, params_from_iter(ids), hook)
    }

    fn recount_degrees(&self, ids: &[String]) -> Result<(), Error> {
        for id in ids {
            self.exec(
                "UPDATE mem_hooks SET degree = (SELECT COUNT(*) FROM mem_links WHERE b = ?1 AND rel = 'about') \
                 WHERE id = ?1",
                [id],
            )?;
        }
        Ok(())
    }

    fn put_link(&self, l: &StoredLink) -> Result<(), Error> {
        self.exec(
            "INSERT INTO mem_links (a, b, rel, weight, co_uses, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT (a, b, rel) DO UPDATE SET weight = excluded.weight, co_uses = excluded.co_uses, \
             updated_at = excluded.updated_at",
            params![l.a, l.b, l.rel, l.weight, l.co_uses, l.updated_at],
        )
        .map(drop)
    }

    fn remove_link(&self, a: &str, b: &str, rel: &str) -> Result<(), Error> {
        self.exec("DELETE FROM mem_links WHERE a = ?1 AND b = ?2 AND rel = ?3", [a, b, rel]).map(drop)
    }

    fn links(&self, ids: &[String]) -> Result<Vec<StoredLink>, Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = placeholders(1, ids.len());
        let sql = format!(
            "SELECT a, b, rel, weight, co_uses, updated_at FROM mem_links WHERE a IN ({list}) \
             UNION SELECT a, b, rel, weight, co_uses, updated_at FROM mem_links WHERE b IN ({list}) ORDER BY 1, 2, 3"
        );
        self.rows(&sql, params_from_iter(ids), link)
    }
}

fn credit(r: &rusqlite::Row<'_>) -> Result<StoredCredit, Error> {
    let read = || -> rusqlite::Result<StoredCredit> {
        Ok(StoredCredit {
            note_id: r.get(0)?,
            device: r.get(1)?,
            counters: Counters { helped: r.get(2)?, hurt: r.get(3)?, used: r.get(4)?, last_used_at: r.get(5)? },
        })
    };
    read().map_err(failed)
}

impl MemCreditRepo for SqliteTx<'_> {
    fn add(
        &self,
        note_id: &str,
        device: &str,
        helped: i64,
        hurt: i64,
        used: i64,
        used_at: Option<i64>,
    ) -> Result<(), Error> {
        self.exec(
            "INSERT INTO mem_credit (note_id, device, helped, hurt, used, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT (note_id, device) DO UPDATE SET helped = helped + excluded.helped, \
             hurt = hurt + excluded.hurt, used = used + excluded.used, \
             last_used_at = MAX(COALESCE(last_used_at, 0), COALESCE(excluded.last_used_at, 0))",
            params![note_id, device, helped, hurt, used, used_at],
        )?;
        // MAX over COALESCE writes 0 for "never used".
        self.exec(
            "UPDATE mem_credit SET last_used_at = NULL WHERE note_id = ?1 AND device = ?2 AND last_used_at = 0",
            [note_id, device],
        )
        .map(drop)
    }

    fn put(&self, c: &StoredCredit) -> Result<(), Error> {
        let n = &c.counters;
        self.exec(
            "INSERT OR REPLACE INTO mem_credit (note_id, device, helped, hurt, used, last_used_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![c.note_id, c.device, n.helped, n.hurt, n.used, n.last_used_at],
        )
        .map(drop)
    }

    fn sum(&self, note_id: &str) -> Result<Counters, Error> {
        self.row(
            "SELECT COALESCE(SUM(helped), 0), COALESCE(SUM(hurt), 0), COALESCE(SUM(used), 0), MAX(last_used_at) \
             FROM mem_credit WHERE note_id = ?1",
            [note_id],
            |r| {
                let read = || -> rusqlite::Result<Counters> {
                    Ok(Counters { helped: r.get(0)?, hurt: r.get(1)?, used: r.get(2)?, last_used_at: r.get(3)? })
                };
                read().map_err(failed)
            },
        )
        .map(Option::unwrap_or_default)
    }

    fn of_device(&self, device: &str) -> Result<Vec<StoredCredit>, Error> {
        self.rows(
            "SELECT note_id, device, helped, hurt, used, last_used_at FROM mem_credit WHERE device = ?1 ORDER BY note_id",
            [device],
            credit,
        )
    }
}
