import { useEffect } from "react";
import { ensurePinsLoaded, usePins } from "../../../state/eos/pinsStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { Ring, Section } from "../frame.jsx";
import { tileAction, tileLocation } from "../home/PinnedTiles.jsx";

const SHEET = "M4.5 2.5h5l2 2v9h-7zM6.5 7h3M6.5 9.5h3";
const ARROW = "M3.5 8h9M9 4.5 12.5 8 9 11.5";

// A Page before its first issue: said as a first step, then the sheet as a
// ghost, its masthead and columns drawn in hairlines, where issue one prints.
export function PageFirst({ maker }) {
  return (
    <>
      <header className="eos-rlead eos-page-first">
        <p className="eos-label">Page · made by {maker}</p>
        <p className="eos-page-first__title">No issue yet.</p>
        <p className="eos-rlead__now">The first one prints with {maker}&apos;s next run.</p>
      </header>
      <div className="eos-page-ghost" aria-hidden="true">
        <span className="eos-page-ghost__mast" />
        <span className="eos-page-ghost__word">Issue 1 prints here</span>
        <span className="eos-page-ghost__cols"><span /><span /><span /></span>
      </div>
    </>
  );
}

// The page while it is read: the strip and the sheet as ghosts, after 300 ms.
export function PageLoading() {
  return (
    <div className="eos-skeleton eos-page-loading" aria-busy="true" aria-label="Loading">
      <span className="eos-skeleton__label" />
      <span className="eos-page-loading__sheet" />
    </div>
  );
}

// A page that left: said as a lead, with the way back Home, then what is
// still pinned there, so the reader goes on from here.
export function PageGone({ surfaceId = null }) {
  const { tiles } = usePins();
  useEffect(() => { void ensurePinsLoaded(); }, []);
  const others = (tiles ?? []).filter((t) => t.surfaceId !== surfaceId);
  return (
    <>
      <header className="eos-rlead eos-page-gone" role="status">
        <p className="eos-label">Page</p>
        <p className="eos-lead">This page is no longer here.</p>
        <p className="eos-rlead__now">Its routine stopped making it, or it was removed.</p>
        <div className="eos-rlead__acts">
          <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "home" }))}>Back to Home</button>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => openLocation(buildLocation({ screen: "routines" }))}>Routines</button>
        </div>
      </header>
      {others.length > 0 && (
        <Section id="eos-page-gone-pins" label="Pinned to Home">
          <div className="eos-rows">
            {others.map((tile) => (
              <div key={tile.surfaceId} className="eos-row eos-page-link__row">
                <Ring d={SHEET} />
                <div className="eos-row__main">
                  <span className="eos-row__title">{tile.title}</span>
                  {tile.headline && <span className="eos-row__line">{tile.headline}</span>}
                </div>
                <button type="button" className="eos-page-link__open" onClick={() => openLocation(tileLocation(tile))}>
                  {tileAction(tile)}
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d={ARROW} /></svg>
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
