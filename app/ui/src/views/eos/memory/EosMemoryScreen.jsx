import { useContext, useEffect, useState } from "react";
import { ensureRoutinesLoaded } from "../../../state/eos/routinesStore.js";
import { refreshMemorySummary, useNotes } from "../../../state/eos/notesStore.js";
import { DevRunNote } from "../capabilities/parts.jsx";
import { Fact } from "../frame.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { AboutYouSlot } from "./aboutYouSlot.js";
import { LearnedFromWork } from "./LearnedFromWork.jsx";
import { NoteDetail } from "./NoteDetail.jsx";
import { holdsLine, weeklyLine } from "./words.js";

const TABS = [
  { key: "about", label: "About you", count: (s) => s?.aboutYou },
  { key: "work", label: "Learned from work", count: (s) => s?.learned },
];

const SEARCH_ICON = "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6L14 14";

// The header's one search: a field with its glass, Escape clears it.
function Search({ query, setQuery }) {
  return (
    <label className="eos-mem-search">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
      <input
        type="search"
        aria-label="Search memory"
        placeholder="Search memory"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
      />
    </label>
  );
}

// eos:/memory?tab=about|work&note=<id> (08 §4.10): what Eos knows about the
// user. It greets as Home does: what Eos learned this week, what it holds,
// and that outside text never writes here. One search in the header looks
// through either tab, so the header stays the same on both. About you is the
// Agents Memory body; Learned from work is what Eos wrote down from
// corrections and outcomes, with one note open beside it.
export function EosMemoryScreen({ tab = "work", note }) {
  const { summary, devRun } = useNotes();
  const AboutYouTab = useContext(AboutYouSlot);
  const [query, setQuery] = useState("");
  useEffect(() => {
    ensureRoutinesLoaded();
    void refreshMemorySummary();
  }, []);
  const weekly = weeklyLine(summary?.weekly ?? 0);
  const holds = holdsLine(summary);

  return (
    <main className="eos-screen eos-screen--wide">
      <EosHeader trail={[{ label: "Memory" }]}>
        <Search query={query} setQuery={setQuery} />
      </EosHeader>
      <div className="eos-body">
        {devRun && <DevRunNote />}
        <header className="eos-rlead eos-mem-lead">
          <p className="eos-label">Memory</p>
          <p className="eos-lead">{weekly ?? "What Eos knows about you and your work."}</p>
          {holds && <p className="eos-rlead__now">{holds}</p>}
          <Fact>Text inside pull requests, mails or web pages can never write here.</Fact>
        </header>
        <nav className="eos-tabs" role="tablist" aria-label="Memory">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className="eos-tab"
              onClick={() => openLocation(buildLocation({ screen: "memory", tab: t.key }))}
            >
              {t.label}
              {t.count(summary) !== undefined && <span className="eos-mem-tab-count">{t.count(summary)}</span>}
            </button>
          ))}
        </nav>
        {tab === "about" ? (
          AboutYouTab ? <AboutYouTab query={query} /> : <p className="eos-note">About you shows in the app.</p>
        ) : (
          <div className={note ? "eos-mem-columns eos-mem-columns--open" : "eos-mem-columns"}>
            <LearnedFromWork summary={summary} query={query} selected={note} onClearSearch={() => setQuery("")} />
            {note && <NoteDetail key={note} id={note} />}
          </div>
        )}
      </div>
    </main>
  );
}
