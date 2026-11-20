//! `mem_notes` and its search index, `mem_vectors`, `mem_versions` and
//! `mem_evidence`.

use eos_core::Error;
use eos_core::store::{
    LiveCount, MEM_EVIDENCE_PER_NOTE, MemEvidenceRepo, MemNoteRepo, MemVectorRepo, MemVersionRepo, NoteQuery,
    StoredEvidence, StoredNote, StoredNoteVersion, StoredVector, WordHit,
};
use eos_domain::experience::state::Counters;
use eos_domain::experience::{Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust};
use eos_kit_sqlite::rusqlite::types::Value as Sql;
use eos_kit_sqlite::rusqlite::{self, params, params_from_iter};

use crate::tx::{SqliteTx, failed, known};

const NOTE_COLUMNS: &str = "rowid, id, kind, text, body, cues, trust, state, scope_level, scope_key, valid_from, \
                            valid_to, replaced_by, do_hooks, avoid_hooks, helped, hurt, used, last_used_at, \
                            activation, created_at, updated_at, device, rev, forgotten_at";

/// A JSON column read back; text this version cannot read fails the read.
fn json<T: serde::de::DeserializeOwned>(r: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<T> {
    let text: String = r.get(idx)?;
    serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e)))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, Error> {
    serde_json::to_string(value).map_err(|e| Error::Storage(format!("json: {e}")))
}

fn note(r: &rusqlite::Row<'_>) -> Result<StoredNote, Error> {
    let read = || -> rusqlite::Result<StoredNote> {
        Ok(StoredNote {
            rowid: r.get(0)?,
            note: Note {
                id: r.get(1)?,
                kind: known(r, 2, NoteKind::parse)?,
                text: r.get(3)?,
                body: json::<NoteBody>(r, 4)?,
                trust: known(r, 6, Trust::parse)?,
                state: known(r, 7, NoteState::parse)?,
                scope: Scope { level: known(r, 8, ScopeLevel::parse)?, key: r.get(9)? },
                valid_from: r.get(10)?,
                valid_to: r.get(11)?,
                replaced_by: r.get(12)?,
                do_hooks: json(r, 13)?,
                avoid_hooks: json(r, 14)?,
                created_at: r.get(20)?,
                updated_at: r.get(21)?,
                device: r.get(22)?,
            },
            cues: r.get(5)?,
            counters: Counters { helped: r.get(15)?, hurt: r.get(16)?, used: r.get(17)?, last_used_at: r.get(18)? },
            activation: r.get(19)?,
            rev: r.get(23)?,
            forgotten_at: r.get(24)?,
        })
    };
    read().map_err(failed)
}

/// `?1, ?2, …` for `n` values, numbered from `from`.
pub(crate) fn placeholders(from: usize, n: usize) -> String {
    (from..from + n).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
}

/// Each word of `words` as a quoted prefix term, any of them matching; `None`
/// when no word is left.
fn match_expr(words: &str) -> Option<String> {
    let terms: Vec<String> = words
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(32)
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

impl MemNoteRepo for SqliteTx<'_> {
    fn insert(&self, n: &Note, cues: &str) -> Result<i64, Error> {
        self.exec(
            "INSERT INTO mem_notes (id, kind, text, body, cues, trust, state, scope_level, scope_key, valid_from, \
             valid_to, replaced_by, do_hooks, avoid_hooks, created_at, updated_at, device) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                n.id,
                n.kind.as_str(),
                n.text,
                to_json(&n.body)?,
                cues,
                n.trust.as_str(),
                n.state.as_str(),
                n.scope.level.as_str(),
                n.scope.key,
                n.valid_from,
                n.valid_to,
                n.replaced_by,
                to_json(&n.do_hooks)?,
                to_json(&n.avoid_hooks)?,
                n.created_at,
                n.updated_at,
                n.device,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn update(&self, n: &Note, cues: &str, rev: i64) -> Result<(), Error> {
        let changed = self.exec(
            "UPDATE mem_notes SET kind = ?2, text = ?3, body = ?4, cues = ?5, trust = ?6, state = ?7, \
             scope_level = ?8, scope_key = ?9, valid_from = ?10, valid_to = ?11, replaced_by = ?12, do_hooks = ?13, \
             avoid_hooks = ?14, updated_at = ?15, device = ?16, rev = ?17 WHERE id = ?1",
            params![
                n.id,
                n.kind.as_str(),
                n.text,
                to_json(&n.body)?,
                cues,
                n.trust.as_str(),
                n.state.as_str(),
                n.scope.level.as_str(),
                n.scope.key,
                n.valid_from,
                n.valid_to,
                n.replaced_by,
                to_json(&n.do_hooks)?,
                to_json(&n.avoid_hooks)?,
                n.updated_at,
                n.device,
                rev,
            ],
        )?;
        if changed == 0 { Err(Error::not_found("note", &n.id)) } else { Ok(()) }
    }

    fn find(&self, id: &str) -> Result<Option<StoredNote>, Error> {
        self.row(&format!("SELECT {NOTE_COLUMNS} FROM mem_notes WHERE id = ?1"), [id], note)
    }

    fn find_rows(&self, rowids: &[i64]) -> Result<Vec<StoredNote>, Error> {
        if rowids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!("SELECT {NOTE_COLUMNS} FROM mem_notes WHERE rowid IN ({})", placeholders(1, rowids.len()));
        self.rows(&sql, params_from_iter(rowids), note)
    }

    fn list(&self, q: &NoteQuery) -> Result<Vec<StoredNote>, Error> {
        let mut clauses: Vec<String> = Vec::new();
        let mut values: Vec<Sql> = Vec::new();
        let bind = |clause: &str, value: Sql, values: &mut Vec<Sql>| {
            values.push(value);
            clause.replace('?', &format!("?{}", values.len()))
        };
        if !q.forgotten {
            clauses.push("forgotten_at IS NULL".to_owned());
        }
        if let Some((level, key)) = &q.scope {
            clauses.push(bind("scope_level = ?", Sql::Text(level.as_str().to_owned()), &mut values));
            if let Some(key) = key {
                clauses.push(bind("scope_key = ?", Sql::Text(key.clone()), &mut values));
            }
        }
        if let Some(kind) = q.kind {
            clauses.push(bind("kind = ?", Sql::Text(kind.as_str().to_owned()), &mut values));
        }
        if let Some(state) = q.state {
            clauses.push(bind("state = ?", Sql::Text(state.as_str().to_owned()), &mut values));
        }
        if let Some(expr) = q.words.as_deref().and_then(match_expr) {
            clauses.push(bind(
                "rowid IN (SELECT rowid FROM mem_notes_fts WHERE mem_notes_fts MATCH ?)",
                Sql::Text(expr),
                &mut values,
            ));
        }
        if let Some((at, id)) = &q.before {
            values.push(Sql::Integer(*at));
            values.push(Sql::Text(id.clone()));
            let (at, id) = (values.len() - 1, values.len());
            clauses.push(format!("(updated_at < ?{at} OR (updated_at = ?{at} AND id < ?{id}))"));
        }
        let filter = if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
        values.push(Sql::Integer(q.limit));
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM mem_notes {filter} ORDER BY updated_at DESC, id DESC LIMIT ?{}",
            values.len()
        );
        self.rows(&sql, params_from_iter(values), note)
    }

    fn search_words(&self, words: &str, limit: i64) -> Result<Vec<WordHit>, Error> {
        let Some(expr) = match_expr(words) else { return Ok(Vec::new()) };
        self.rows(
            "SELECT f.rowid, bm25(mem_notes_fts) AS rank FROM mem_notes_fts f JOIN mem_notes n ON n.rowid = f.rowid \
             WHERE mem_notes_fts MATCH ?1 AND n.forgotten_at IS NULL ORDER BY rank LIMIT ?2",
            params![expr, limit],
            |r| Ok(WordHit { rowid: r.get(0).map_err(failed)?, rank: r.get(1).map_err(failed)? }),
        )
    }

    fn set_standing(&self, id: &str, c: Counters, activation: f64, state: NoteState) -> Result<(), Error> {
        self.exec(
            "UPDATE mem_notes SET helped = ?2, hurt = ?3, used = ?4, last_used_at = ?5, activation = ?6, state = ?7 \
             WHERE id = ?1",
            params![id, c.helped, c.hurt, c.used, c.last_used_at, activation, state.as_str()],
        )
        .map(drop)
    }

    fn set_forgotten(&self, id: &str, at: Option<i64>) -> Result<(), Error> {
        self.exec("UPDATE mem_notes SET forgotten_at = ?2 WHERE id = ?1", params![id, at]).map(drop)
    }

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM mem_notes WHERE id = ?1", [id]).map(drop)
    }

    fn changed_since(&self, since: i64) -> Result<Vec<StoredNote>, Error> {
        self.rows(
            &format!("SELECT {NOTE_COLUMNS} FROM mem_notes WHERE updated_at > ?1 ORDER BY updated_at, id"),
            [since],
            note,
        )
    }

    fn ids(&self) -> Result<Vec<String>, Error> {
        self.rows("SELECT id FROM mem_notes ORDER BY id", [], |r| r.get(0).map_err(failed))
    }

    fn live_count(&self) -> Result<i64, Error> {
        self.row("SELECT COUNT(*) FROM mem_notes WHERE state != 'closed' AND forgotten_at IS NULL", [], |r| {
            r.get(0).map_err(failed)
        })
        .map(Option::unwrap_or_default)
    }

    fn live_counts(&self) -> Result<Vec<LiveCount>, Error> {
        self.rows(
            "SELECT scope_level, scope_key, kind, COUNT(*) FROM mem_notes \
             WHERE state != 'closed' AND forgotten_at IS NULL GROUP BY scope_level, scope_key, kind \
             ORDER BY scope_level, scope_key, kind",
            [],
            |r| {
                let read = || -> rusqlite::Result<LiveCount> {
                    Ok(LiveCount {
                        scope: Scope { level: known(r, 0, ScopeLevel::parse)?, key: r.get(1)? },
                        kind: known(r, 2, NoteKind::parse)?,
                        count: r.get(3)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }

    fn learned_since(&self, since: i64) -> Result<i64, Error> {
        self.row(
            "SELECT COUNT(*) FROM mem_notes WHERE state != 'closed' AND forgotten_at IS NULL \
             AND kind != 'episode' AND created_at >= ?1",
            [since],
            |r| r.get(0).map_err(failed),
        )
        .map(Option::unwrap_or_default)
    }
}

fn vector(r: &rusqlite::Row<'_>) -> Result<StoredVector, Error> {
    let read = || -> rusqlite::Result<StoredVector> {
        let blob: Vec<u8> = r.get(3)?;
        Ok(StoredVector {
            note_rowid: r.get(0)?,
            model: r.get(1)?,
            scale: r.get::<_, f64>(2)? as f32,
            vec: blob.into_iter().map(|b| b as i8).collect(),
        })
    };
    read().map_err(failed)
}

impl MemVectorRepo for SqliteTx<'_> {
    fn put(&self, v: &StoredVector) -> Result<(), Error> {
        let blob: Vec<u8> = v.vec.iter().map(|&b| b as u8).collect();
        self.exec(
            "INSERT INTO mem_vectors (note_rowid, model, dims, scale, vec) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (note_rowid) DO UPDATE SET model = excluded.model, dims = excluded.dims, \
             scale = excluded.scale, vec = excluded.vec",
            params![v.note_rowid, v.model, v.vec.len() as i64, f64::from(v.scale), blob],
        )
        .map(drop)
    }

    fn all(&self, model: &str) -> Result<Vec<StoredVector>, Error> {
        self.rows(
            "SELECT note_rowid, model, scale, vec FROM mem_vectors WHERE model = ?1 ORDER BY note_rowid",
            [model],
            vector,
        )
    }

    fn missing(&self, model: &str, limit: i64) -> Result<Vec<(i64, String)>, Error> {
        self.rows(
            "SELECT n.rowid, n.text FROM mem_notes n LEFT JOIN mem_vectors v ON v.note_rowid = n.rowid AND v.model = ?1 \
             WHERE v.note_rowid IS NULL AND n.forgotten_at IS NULL ORDER BY n.rowid LIMIT ?2",
            params![model, limit],
            |r| Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?)),
        )
    }

    fn clear(&self) -> Result<(), Error> {
        self.exec("DELETE FROM mem_vectors", []).map(drop)
    }
}

fn version(r: &rusqlite::Row<'_>) -> Result<StoredNoteVersion, Error> {
    let read = || -> rusqlite::Result<StoredNoteVersion> {
        Ok(StoredNoteVersion {
            note_id: r.get(0)?,
            rev: r.get(1)?,
            text: r.get(2)?,
            body: r.get(3)?,
            scope_level: known(r, 4, ScopeLevel::parse)?,
            scope_key: r.get(5)?,
            state: known(r, 6, NoteState::parse)?,
            why: r.get(7)?,
            at: r.get(8)?,
        })
    };
    read().map_err(failed)
}

impl MemVersionRepo for SqliteTx<'_> {
    fn insert(&self, v: &StoredNoteVersion) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO mem_versions (note_id, rev, text, body, scope_level, scope_key, state, why, at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                v.note_id,
                v.rev,
                v.text,
                v.body,
                v.scope_level.as_str(),
                v.scope_key,
                v.state.as_str(),
                v.why,
                v.at
            ],
        )
        .map(drop)
    }

    fn of_note(&self, note_id: &str) -> Result<Vec<StoredNoteVersion>, Error> {
        self.rows(
            "SELECT note_id, rev, text, body, scope_level, scope_key, state, why, at FROM mem_versions \
             WHERE note_id = ?1 ORDER BY rev DESC",
            [note_id],
            version,
        )
    }
}

fn evidence(r: &rusqlite::Row<'_>) -> Result<StoredEvidence, Error> {
    let read = || -> rusqlite::Result<StoredEvidence> {
        Ok(StoredEvidence {
            id: r.get(0)?,
            note_id: r.get(1)?,
            kind: r.get(2)?,
            summary: r.get(3)?,
            worker_id: r.get(4)?,
            row_from: r.get(5)?,
            row_to: r.get(6)?,
            run_id: r.get(7)?,
            at: r.get(8)?,
            device: r.get(9)?,
        })
    };
    read().map_err(failed)
}

impl MemEvidenceRepo for SqliteTx<'_> {
    fn insert(&self, e: &StoredEvidence) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO mem_evidence (id, note_id, kind, summary, worker_id, row_from, row_to, run_id, at, \
             device) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![e.id, e.note_id, e.kind, e.summary, e.worker_id, e.row_from, e.row_to, e.run_id, e.at, e.device],
        )?;
        self.exec(
            "DELETE FROM mem_evidence WHERE note_id = ?1 AND id NOT IN \
             (SELECT id FROM mem_evidence WHERE note_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2)",
            params![e.note_id, MEM_EVIDENCE_PER_NOTE],
        )
        .map(drop)
    }

    fn of_note(&self, note_id: &str, limit: i64) -> Result<Vec<StoredEvidence>, Error> {
        self.rows(
            "SELECT id, note_id, kind, summary, worker_id, row_from, row_to, run_id, at, device FROM mem_evidence \
             WHERE note_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
            params![note_id, limit],
            evidence,
        )
    }
}
