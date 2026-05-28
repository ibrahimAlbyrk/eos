import { modelShort, statusFromState } from "../../lib/format.js";

function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}

// Adapts live workers into searchable results. Selecting one jumps to the Code
// tab and focuses that agent.
export const agentsProvider = {
  id: "agents",
  label: "Agents",
  getResults(ctx) {
    return (ctx.workers || []).map((w) => {
      const status = statusFromState(w.state)?.label;
      return {
        id: `agent:${w.id}`,
        icon: "agent",
        title: nameOf(w),
        subtitle: [modelShort(w.model), status].filter(Boolean).join(" · "),
        keywords: [w.model, w.state, w.id].filter(Boolean),
        onSelect: (ctx) => {
          ctx.setActiveView("code");
          ctx.setSelectedId(w.id);
        },
      };
    });
  },
};
