import { useEffect, useMemo, useState } from "react";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { loadMoreNotes, loadNotes, notesPath, useNotes } from "../../../state/eos/notesStore.js";
import { LoadFailed, Loading } from "../capabilities/parts.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { routineScope } from "../routine/WhatItLearned.jsx";
import { KIND_FILTERS, provenance, scopeName, sourceWord, strengthSteps } from "./words.js";

const SEARCH_WAIT_MS = 250;

export function StrengthBar({ strength }) {
  const steps = strengthSteps(strength);
  return (
    <span className="eos-mem-strength" role="img" aria-label={`Strength ${steps} of 5`}>
      {Array.from({ length: 5 }, (_, i) => <span key={i} className={i < steps ? "eos-mem-strength__on" : undefined} />)}
    </span>
  );
}

export function NoteRow({ row, selected, onOpen }) {
  return (
    <li className="eos-mem-row">
      <button type="button" className="eos-mem-row__open" aria-current={selected ? "true" : undefined} onClick={onOpen}>
        <span className="eos-mem-row__text">{row.text}</span>
        <span className="eos-mem-row__why">{provenance(row)}</span>
      </button>
      <span className="eos-chip">{sourceWord(row.trust)}</span>
      <StrengthBar strength={row.strength} />
    </li>
  );
}

// Rows grouped by where they hold, in the order they first appear;
// everywhere last. A group's count is the scope's whole count when the head knows it.
function groupsOf(notes, scopes, routines) {
  const groups = new Map();
  for (const row of notes) {
    const key = `${row.scope.level}:${row.scope.key}`;
    if (!groups.has(key)) {
      const known = scopes?.find((s) => s.level === row.scope.level && s.key === row.scope.key);
      groups.set(key, { key, label: scopeName(row.scope, routines), level: row.scope.level, count: known?.count, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.level !== "everywhere"), ...all.filter((g) => g.level === "everywhere")];
}

// The chips: everything, each project and routine with notes, then the kinds.
function Filters({ scopes, routines, scope, kind, onScope, onKind, placed }) {
  const places = placed ? [] : (scopes ?? []).filter((s) => s.level === "project" || s.level === "routine");
  const chip = (on, label, onClick, key) => (
    <button key={key} type="button" className="eos-chip eos-mem-filter" aria-pressed={on} onClick={onClick}>{label}</button>
  );
  return (
    <nav className="eos-mem-filters" aria-label="Filter notes">
      {!placed && chip(!scope, "Everything", () => onScope(undefined), "all")}
      {places.map((s) => {
        const value = `${s.level}:${s.key}`;
        return chip(scope === value, scopeName(s, routines), () => onScope(scope === value ? undefined : value), value);
      })}
      {!placed && <span className="eos-mem-filters__sep" aria-hidden="true" />}
      {KIND_FILTERS.map((k) => chip(kind === k.kind, k.label, () => onKind(kind === k.kind ? undefined : k.kind), k.kind))}
    </nav>
  );
}

// Eos › Memory › Learned from work: the notes Eos learned, filtered, searched
// and grouped by scope; a row opens its detail beside the list. With
// `routineId` it holds that routine's notes only (its Learned tab).
export function LearnedFromWork({ summary, query = "", selected, routineId }) {
  const { pages, pagesFailed } = useNotes();
  const { list: routines } = useRoutines();
  const [chosen, setScope] = useState();
  const scope = routineId ? routineScope(routineId) : chosen;
  const [kind, setKind] = useState();
  const [q, setQ] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setQ(query), SEARCH_WAIT_MS);
    return () => clearTimeout(t);
  }, [query]);
  const path = notesPath({ scope, kind, q: q.trim() });
  useEffect(() => void loadNotes(path), [path]);
  const page = pages[path];
  const groups = useMemo(() => (page ? groupsOf(page.notes, summary?.scopes, routines) : []), [page, summary, routines]);
  const open = (id) => openLocation(buildLocation({ screen: "memory", tab: "work", note: id }));

  let body;
  if (!page) body = pagesFailed[path] ? <LoadFailed what="notes" retry={() => void loadNotes(path)} /> : <Loading />;
  else if (page.notes.length === 0) {
    body = <p className="eos-note">{chosen || kind || q.trim() ? "No note matches." : "Nothing learned yet. Eos writes notes down as you correct its work."}</p>;
  } else {
    body = (
      <>
        {groups.map((g) => (
          <section key={g.key} className="eos-card eos-mem-group" aria-label={g.label}>
            <header className="eos-mem-group__head">
              <h2 className="eos-mem-group__name">{g.label}</h2>
              <span className="eos-mem-group__count">{g.count ?? g.rows.length}</span>
            </header>
            <ul className="eos-mem-rows">
              {g.rows.map((row) => <NoteRow key={row.id} row={row} selected={row.id === selected} onOpen={() => open(row.id)} />)}
            </ul>
          </section>
        ))}
        {page.nextCursor && <button type="button" className="eos-btn" onClick={() => void loadMoreNotes(path)}>Show more</button>}
      </>
    );
  }

  return (
    <div className="eos-mem-learned">
      <Filters scopes={summary?.scopes} routines={routines} scope={scope} kind={kind} onScope={setScope} onKind={setKind} placed={Boolean(routineId)} />
      {body}
    </div>
  );
}
