import { createRoot } from "react-dom/client";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { EosMain } from "../EosMain.jsx";
import { EosSidebarRows } from "../sidebar/EosSidebar.jsx";
import routinesOne from "./sample/routines-one.json";

// What the gallery's reads answer, by the path each store asks.
export const SAMPLE_READS = { [ROUTES.routines]: routinesOne };

// Eos's columns in the app's grid. The chrome around them (the mode switcher,
// the account footer) reads the core, so the gallery leaves it out.
export function EosGallery() {
  return (
    <div className="app">
      <aside className="side">
        <div className="side-island side-island--agents"><EosSidebarRows /></div>
      </aside>
      <section className="center"><EosMain /></section>
    </div>
  );
}

// The #eos-gallery page (main.jsx): Eos drawn from sample JSON. It never calls
// the core: every read answers from a sample and every write is refused.
export function startEosGallery(rootEl) {
  setEosTransport(fixtureTransport(SAMPLE_READS));
  createRoot(rootEl).render(<EosGallery />);
}
