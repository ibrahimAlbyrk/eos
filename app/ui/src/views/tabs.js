import { codeMeta } from "./code/meta.jsx";
import { homeMeta } from "./home/meta.jsx";

// Workspace targets for the Eos ▾ switcher (was the Home|Code TabBar). Order is
// the switcher's display order: Code first, then Home. Kept separate from
// registry.js (which pulls in the heavy view Components) so the switcher — shared
// chrome — does not create an import cycle.
export const TABS = [codeMeta, homeMeta];
