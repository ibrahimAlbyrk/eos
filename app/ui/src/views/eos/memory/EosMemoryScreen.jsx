import { useContext, useEffect, useState } from "react";
import { ensureRoutinesLoaded } from "../../../state/eos/routinesStore.js";
import { refreshMemorySummary, useNotes } from "../../../state/eos/notesStore.js";
import { DevRunNote } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { AboutYouSlot } from "./aboutYouSlot.js";
import { LearnedFromWork } from "./LearnedFromWork.jsx";
import { NoteDetail } from "./NoteDetail.jsx";
import { weeklyLine } from "./words.js";

const TABS = [
  { key: "about", label: "About you", count: (s) => s?.aboutYou },
  { key: "work", label: "Learned from work", count: (s) => s?.learned },
];

// eos:/memory?tab=about|work&note=<id> (08 §4.10): what Eos knows about the
// user. One search in the header looks through either tab, so the header
// stays the same height on both. About you is the Agents Memory body; Learned from work is what Eos
// wrote down from corrections and outcomes, with one note open beside it.
export function EosMemoryScreen({ tab = "work", note }) {
  const { summary, devRun } = useNotes();
  const AboutYouTab = useContext(AboutYouSlot);
  const [query, setQuery] = useState("");
  useEffect(() => {
    ensureRoutinesLoaded();
    void refreshMemorySummary();
  }, []);
  const weekly = weeklyLine(summary?.weekly ?? 0);

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Memory" }]}>
        <input className="eos-mem-search" type="search" aria-label="Search memory" placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} />
      </EosHeader>
      <div className="eos-body">
        {devRun && <DevRunNote />}
        {weekly && <p className="eos-mem-weekly">{weekly}</p>}
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
          <div className="eos-mem-columns">
            <LearnedFromWork summary={summary} query={query} selected={note} />
            {note && <NoteDetail key={note} id={note} />}
          </div>
        )}
        <p className="eos-mem-foot">Text inside pull requests, mails or web pages can never write here.</p>
      </div>
    </main>
  );
}
