import { useEffect } from "react";
import { loadRoutinePage, pickIssue, usePages } from "../../../state/eos/pageStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { issueLine } from "./words.js";

// On a routine's page: the Page it fills, its newest issue, and the way there.
export function RoutinePageLink({ routineId }) {
  const { byRoutine, pages } = usePages();
  useEffect(() => { void loadRoutinePage(routineId); }, [routineId]);
  const id = byRoutine[routineId];
  const page = id ? pages[id] : null;
  if (!page?.surface) return null;
  const row = pickIssue(page.issues);
  return (
    <section className="eos-card eos-page-link" aria-label="Its page">
      <div className="eos-page-link__text">
        <span className="eos-page-link__title">{page.surface.title}</span>
        <span className="eos-page-link__line">{row ? issueLine(row) : "No issue yet."}</span>
      </div>
      <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId: id }))}>
        {row ? "Read it" : "Open the page"}
      </button>
    </section>
  );
}
