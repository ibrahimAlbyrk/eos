import { buildLocation, openLocation } from "../nav/eosNav.js";

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

// A page that left: said as a lead, with the way back Home.
export function PageGone() {
  return (
    <header className="eos-rlead eos-page-gone" role="status">
      <p className="eos-lead">This page is no longer here.</p>
      <p className="eos-rlead__now">Its routine stopped making it, or it was removed.</p>
      <div className="eos-rlead__acts">
        <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "home" }))}>Back to Home</button>
      </div>
    </header>
  );
}
