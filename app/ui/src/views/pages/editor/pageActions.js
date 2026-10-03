import { Facet } from "@codemirror/state";

// The page editor's link to its panel: a ref whose `current` holds the
// callbacks (hand a task to the agent, add text to the chat, …) and context
// (project folder, whether an agent is reachable). A ref so the editor never
// rebuilds when the panel re-renders with fresh closures.
export const pageActions = Facet.define({ combine: (values) => values[0] ?? { current: {} } });

export const actionsOf = (state) => state.facet(pageActions).current ?? {};
