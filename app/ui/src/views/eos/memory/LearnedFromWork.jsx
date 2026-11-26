import { Fragment, useEffect, useMemo, useState } from "react";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { loadMoreNotes, loadNotes, notesPath, useNotes } from "../../../state/eos/notesStore.js";
import { LoadFailed, LoadingRows } from "../capabilities/parts.jsx";
import { Fact, Ways } from "../frame.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { routineScope } from "../routine/WhatItLearned.jsx";
import { foundLine, KIND_FILTERS, provenance, scopeName, sourceWord, strengthSteps } from "./words.js";

const SEARCH_WAIT_MS = 250;

// Strength as five small marks, lit as far as the note is strong.
export function StrengthBar({ strength }) {
  const steps = strengthSteps(strength);
  return (
    <span className="eos-mem-strength" role="img" aria-label={`Strength ${steps} of 5`}>
      {Array.from({ length: 5 }, (_, i) => <span key={i} className={i < steps ? "eos-mem-strength__on" : undefined} />)}
    </span>
  );
}

// The words of `text` with each place `q` is found lit.
function Lit({ text, q }) {
  const lower = text.toLowerCase();
  const find = q.toLowerCase();
  let i = find ? lower.indexOf(find) : -1;
  if (i < 0) return text;
  const parts = [];
  let from = 0;
  while (i >= 0) {
    parts.push(<Fragment key={`t${from}`}>{text.slice(from, i)}</Fragment>, <mark key={`m${i}`} className="eos-mem-hit">{text.slice(i, i + find.length)}</mark>);
    from = i + find.length;
    i = lower.indexOf(find, from);
  }
  parts.push(<Fragment key={`t${from}`}>{text.slice(from)}</Fragment>);
  return parts;
}

// A note: its state as a mark (trying lit, firm solid, cooling hollow), its
// words and why, who taught it and how strong it is.
export function NoteRow({ row, selected, onOpen, q = "" }) {
  return (
    <li className={row.state === "cooling" ? "eos-mem-row eos-mem-row--cooling" : "eos-mem-row"}>
      <span className={`eos-mem-mark eos-mem-mark--${row.state}`} aria-hidden="true" />
      <button type="button" className="eos-mem-row__open" aria-current={selected ? "true" : undefined} onClick={onOpen}>
        <span className="eos-mem-row__text"><Lit text={row.text} q={q} /></span>
        <span className="eos-mem-row__why">{provenance(row)}</span>
      </button>
      <span className="eos-mem-row__source">{sourceWord(row.trust)}</span>
      <StrengthBar strength={row.strength} />
    </li>
  );
}

// Rows grouped by where they hold, in the order they first appear;
// everywhere last. A group's count is the scope's whole count when the head
// knows it and nothing narrows the list.
function groupsOf(notes, scopes, routines, narrowed) {
  const groups = new Map();
  for (const row of notes) {
    const key = `${row.scope.level}:${row.scope.key}`;
    if (!groups.has(key)) {
      const known = narrowed ? null : scopes?.find((s) => s.level === row.scope.level && s.key === row.scope.key);
      groups.set(key, { key, label: scopeName(row.scope, routines), level: row.scope.level, count: known?.count, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.level !== "everywhere"), ...all.filter((g) => g.level === "everywhere")];
}

// The filters, each on its own labelled line so the two questions do not
// read as one: where a note holds (anywhere, each project and routine with
// notes) and what kind it is. On a place's own page only the kind is asked.
function Filters({ scopes, routines, scope, kind, onScope, onKind, placed }) {
  const places = placed ? [] : (scopes ?? []).filter((s) => s.level === "project" || s.level === "routine");
  const chip = (on, label, onClick, key, kindOf = false) => (
    <button key={key} type="button" className={kindOf ? "eos-chip eos-mem-filter eos-mem-filter--kind" : "eos-chip eos-mem-filter"} aria-pressed={on} onClick={onClick}>{label}</button>
  );
  return (
    <nav className="eos-mem-filters" aria-label="Filter notes">
      {!placed && places.length > 0 && (
        <div className="eos-mem-filters__line" role="group" aria-labelledby="eos-mem-where">
          <span id="eos-mem-where" className="eos-label">Where</span>
          {chip(!scope, "Everything", () => onScope(undefined), "all")}
          {places.map((s) => {
            const value = `${s.level}:${s.key}`;
            return chip(scope === value, scopeName(s, routines), () => onScope(scope === value ? undefined : value), value);
          })}
        </div>
      )}
      <div className="eos-mem-filters__line" role="group" aria-labelledby="eos-mem-kind">
        <span id="eos-mem-kind" className="eos-label">Kind</span>
        {chip(!kind, "All", () => onKind(undefined), "all-kinds", true)}
        {KIND_FILTERS.map((k) => chip(kind === k.kind, k.label, () => onKind(kind === k.kind ? undefined : k.kind), k.kind, true))}
      </div>
    </nav>
  );
}

// How Eos learns, for the place before it has learned anything.
const WAYS = [
  ["You correct its work", "What you change in a draft before it goes, Eos keeps for next time.", "M3 12.5l1-3.5 7-7 2.5 2.5-7 7zM9.5 3.5l2.5 2.5"],
  ["A run fails, then works", "What fixed it is written down, so the next run starts there.", "M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3M12 2v3h-3M4 14v-3h3"],
  ["You say a rule", "“Always…” or “never…” said in a chat becomes a note that holds.", "M3 4.5h10v6H7l-3 2.5v-2.5H3z"],
  ["Never from outside text", "A pull request, a mail or a web page can never write here.", "M8 2.5l5 2v3.6c0 3-2.2 4.9-5 5.7-2.8-.8-5-2.7-5-5.7V4.5z"],
];

function NothingYet() {
  return (
    <div className="eos-mem-first">
      <div>
        <p className="eos-mem-first__title">Nothing learned from work yet.</p>
        <p className="eos-mem-first__line">Eos writes a note down when you correct its work or a run fails and something fixes it. Each note shows here with what taught it.</p>
      </div>
      <Ways id="eos-mem-ways" label="How Eos learns" ways={WAYS} />
    </div>
  );
}

// How to read a row, beside the list while no note is open: the state marks,
// the strength marks and who taught it, said once so the rows stay bare.
const KEY_STATES = [
  ["trying", "Trying it", "New. Eos reads it where it fits and watches whether it helps."],
  ["firm", "Firm", "It helped often enough to hold."],
  ["cooling", "Cooling", "It has not come back for a while and fades unless it does."],
];

export function NoteKey() {
  return (
    <aside className="eos-mem-key" aria-label="How to read a note">
      <h2 className="eos-label">How to read a note</h2>
      <ul className="eos-mem-key__list">
        {KEY_STATES.map(([state, title, line]) => (
          <li key={state} className="eos-mem-key__item">
            <span className={`eos-mem-mark eos-mem-mark--${state}`} aria-hidden="true" />
            <span className="eos-mem-key__text"><span className="eos-mem-key__title">{title}</span><span className="eos-mem-key__line">{line}</span></span>
          </li>
        ))}
        <li className="eos-mem-key__item eos-mem-key__item--strength">
          <StrengthBar strength={0.6} />
          <span className="eos-mem-key__text"><span className="eos-mem-key__title">Strength</span><span className="eos-mem-key__line">How often it came back and helped.</span></span>
        </li>
      </ul>
      <p className="eos-mem-key__foot">Open a note to see what taught it, when it comes back and whether it helped.</p>
    </aside>
  );
}

// Eos › Memory › Learned from work: the notes Eos learned, filtered, searched
// and grouped by scope; a row opens its detail beside the list. With
// `routineId` it holds that routine's notes only (its Learned tab).
export function LearnedFromWork({ summary, query = "", selected, routineId, onClearSearch, withKey = false }) {
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
  const words = q.trim();
  const path = notesPath({ scope, kind, q: words });
  useEffect(() => void loadNotes(path), [path]);
  const page = pages[path];
  const narrowed = Boolean(chosen || kind || words);
  const groups = useMemo(() => (page ? groupsOf(page.notes, summary?.scopes, routines, narrowed) : []), [page, summary, routines, narrowed]);
  const open = (id) => openLocation(buildLocation({ screen: "memory", tab: "work", note: id }));
  const clear = () => {
    setScope(undefined);
    setKind(undefined);
    if (words) onClearSearch?.();
  };

  let body;
  if (!page) body = pagesFailed[path] ? <LoadFailed what="notes" retry={() => void loadNotes(path)} /> : <LoadingRows />;
  else if (page.notes.length === 0) {
    body = narrowed
      ? (
        <Fact actions={<button type="button" className="eos-btn eos-btn--quiet" onClick={clear}>Show every note</button>}>
          {words ? foundLine(0, words) : "No note matches."}
        </Fact>
      )
      : <NothingYet />;
  } else if (words) {
    // A search is one list of what it found, the words lit where they are.
    body = (
      <section className="eos-mem-group" aria-label="Found">
        <header className="eos-mem-group__head">
          <h2 className="eos-mem-group__name eos-mem-group__name--found">{foundLine(page.notes.length, words)}</h2>
        </header>
        <ul className="eos-mem-rows">
          {page.notes.map((row) => <NoteRow key={row.id} row={row} q={words} selected={row.id === selected} onOpen={() => open(row.id)} />)}
        </ul>
      </section>
    );
  } else {
    body = (
      <>
        {groups.map((g) => (
          <section key={g.key} className="eos-mem-group" aria-label={g.label}>
            {!routineId && (
              <header className="eos-mem-group__head">
                <h2 className="eos-mem-group__name">{g.label}</h2>
                <span className="eos-mem-group__count">{g.count ?? g.rows.length}</span>
              </header>
            )}
            <ul className="eos-mem-rows">
              {g.rows.map((row) => <NoteRow key={row.id} row={row} selected={row.id === selected} onOpen={() => open(row.id)} />)}
            </ul>
          </section>
        ))}
        {page.nextCursor && <button type="button" className="eos-btn eos-btn--quiet eos-mem-more" onClick={() => void loadMoreNotes(path)}>Show more</button>}
      </>
    );
  }

  const bare = page && page.notes.length === 0 && !narrowed;
  return (
    <>
      <div className="eos-mem-learned">
        {/* In a routine's tab the list's label comes first, then its filters, as on its other tabs. */}
        {routineId && !bare && (
          <header className="eos-mem-group__head">
            <h2 className="eos-mem-group__name">What it learned from you</h2>
            {page && <span className="eos-mem-group__count">{groups.reduce((n, g) => n + (g.count ?? g.rows.length), 0)}</span>}
          </header>
        )}
        {!bare && <Filters scopes={summary?.scopes} routines={routines} scope={scope} kind={kind} onScope={setScope} onKind={setKind} placed={Boolean(routineId)} />}
        {body}
      </div>
      {withKey && page?.notes.length > 0 && <NoteKey />}
    </>
  );
}
