import { homeMeta } from "./home/meta.jsx";
import { codeMeta } from "./code/meta.jsx";

// Component-free tab descriptors consumed by TabBar. Kept separate from
// registry.js (which pulls in the heavy view Components) so TabBar — rendered
// inside every view via AppLayout — does not create an import cycle.
export const TABS = [homeMeta, codeMeta];
