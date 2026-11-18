import { eosMeta } from "./eos/meta.jsx";
import { agentsMeta } from "./agents/meta.jsx";
import { codeMeta } from "./code/meta.jsx";
import { machinesMeta } from "./machines/meta.jsx";

// Workspace targets for the Eos ▾ switcher. Order is the switcher's display
// order and the ⌘⌃1…9 order. Kept separate from registry.js (which pulls in the
// heavy view Components) so the switcher — shared chrome — does not create an
// import cycle.
export const TABS = [eosMeta, agentsMeta, codeMeta, machinesMeta];

// A tab may hide itself (`visible()`), e.g. Machines inside a controlled
// computer's view, or Eos while the core does not serve routines.
export const visibleTabs = () => TABS.filter((t) => !t.visible || t.visible());
