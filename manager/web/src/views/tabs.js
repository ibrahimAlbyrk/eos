import { codeMeta } from "./code/meta.jsx";
import { workflowsMeta } from "./workflows/meta.jsx";

// Component-free tab descriptors consumed by TabBar. Kept separate from
// registry.js (which pulls in the heavy view Components) so TabBar — rendered
// inside every view via AppLayout — does not create an import cycle.
export const TABS = [codeMeta, workflowsMeta];
