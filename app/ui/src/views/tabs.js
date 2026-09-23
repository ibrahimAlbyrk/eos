import { agentsMeta } from "./agents/meta.jsx";
import { codeMeta } from "./code/meta.jsx";

// Workspace targets for the Eos ▾ switcher. Order is the switcher's display
// order. Kept separate from registry.js (which pulls in the heavy view
// Components) so the switcher — shared chrome — does not create an import cycle.
export const TABS = [agentsMeta, codeMeta];
