import { useEffect } from "react";
import { loadRoutinePage, pickIssue, usePages } from "../../../state/eos/pageStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { Ring, Section } from "../frame.jsx";
import { issueLine } from "./words.js";

const SHEET = "M4.5 2.5h5l2 2v9h-7zM6.5 7h3M6.5 9.5h3";
const ARROW = "M3.5 8h9M9 4.5 12.5 8 9 11.5";

// On a routine's page: the Page it fills, as one row on hairlines under its
// label: the sheet in its ring, the page's name and its newest issue, and the
// way there. The whole row opens it.
export function RoutinePageLink({ routineId }) {
  const { byRoutine, pages } = usePages();
  useEffect(() => { void loadRoutinePage(routineId); }, [routineId]);
  const id = byRoutine[routineId];
  const page = id ? pages[id] : null;
  if (!page?.surface) return null;
  const row = pickIssue(page.issues);
  const open = () => openLocation(buildLocation({ screen: "surface", surfaceId: id }));
  return (
    <div className="eos-routine__section eos-page-link">
      <Section id="eos-page-link" label="Its page" aside={page.issues?.length ? `${page.issues.length}${page.more ? "+" : ""} ${page.issues.length === 1 ? "issue" : "issues"}` : null}>
        <div className="eos-rows">
          <div className="eos-row eos-page-link__row">
            <Ring d={SHEET} />
            <div className="eos-row__main">
              <span className="eos-row__title">{page.surface.title}</span>
              <span className="eos-row__line">{row ? issueLine(row) : "No issue yet. The next run prints the first."}</span>
            </div>
            <button type="button" className="eos-page-link__open" onClick={open}>
              {row ? "Read it" : "Open the page"}
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d={ARROW} /></svg>
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}
