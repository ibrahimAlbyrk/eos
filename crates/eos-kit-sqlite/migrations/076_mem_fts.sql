    -- Search of memory notes by words: their text and their hooks' keys,
    -- diacritics folded so Turkish and English words meet. An index over
    -- mem_notes (external content), kept by its triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_notes_fts USING fts5(
      text, cues, content='mem_notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS mem_notes_fts_insert AFTER INSERT ON mem_notes BEGIN
      INSERT INTO mem_notes_fts(rowid, text, cues) VALUES (new.rowid, new.text, new.cues);
    END;
    CREATE TRIGGER IF NOT EXISTS mem_notes_fts_delete AFTER DELETE ON mem_notes BEGIN
      INSERT INTO mem_notes_fts(mem_notes_fts, rowid, text, cues) VALUES ('delete', old.rowid, old.text, old.cues);
    END;
    CREATE TRIGGER IF NOT EXISTS mem_notes_fts_update AFTER UPDATE OF text, cues ON mem_notes BEGIN
      INSERT INTO mem_notes_fts(mem_notes_fts, rowid, text, cues) VALUES ('delete', old.rowid, old.text, old.cues);
      INSERT INTO mem_notes_fts(rowid, text, cues) VALUES (new.rowid, new.text, new.cues);
    END;
