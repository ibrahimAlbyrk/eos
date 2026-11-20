import { Fragment } from "react";
import { openLocation } from "./eosNav.js";
import { HaltBand } from "./HaltBand.jsx";

// Every Eos screen's header: a breadcrumb whose last part is the screen's h1.
// `trail` is [{ label, location }…, { label }]: each earlier part opens its
// location. It is the app's title bar too (.pane-head: the window drags by it,
// and it clears the window's buttons while the sidebar is collapsed).
// `children` sit after the title: a screen's chips and buttons. Under it,
// on every screen, the band that says Eos is stopped.
export function EosHeader({ trail, children }) {
  const parents = trail.slice(0, -1);
  const title = trail[trail.length - 1].label;
  return (
    <>
      <header className="pane-head pane-head--topleft eos-head">
        <span className="pane-head-inset" aria-hidden="true" />
        {parents.length > 0 && (
          <nav className="eos-crumbs" aria-label="Breadcrumb">
            {parents.map((p) => (
              <Fragment key={p.location}>
                <button type="button" className="eos-crumb" onClick={() => openLocation(p.location)}>{p.label}</button>
                <span className="eos-crumb-sep" aria-hidden="true">/</span>
              </Fragment>
            ))}
          </nav>
        )}
        <h1 className="eos-title">{title}</h1>
        {children && <div className="eos-head__side">{children}</div>}
      </header>
      <HaltBand />
    </>
  );
}
