// Adapts workflows into searchable results. The Workflows tab has no data
// source yet, so this yields nothing today — but once ctx.workflows is wired,
// results appear automatically with no change to the palette or registry.
export const workflowsProvider = {
  id: "workflows",
  label: "Workflows",
  getResults(ctx) {
    return (ctx.workflows || []).map((wf) => ({
      id: `workflow:${wf.id}`,
      icon: "workflow",
      title: wf.name || wf.id,
      subtitle: wf.description || "",
      keywords: [wf.id].filter(Boolean),
      onSelect: (ctx) => {
        ctx.setActiveView("workflows");
        ctx.onSelectWorkflow?.(wf.id);
      },
    }));
  },
};
