// Prompt templates as palette results. Selecting one jumps to the Code tab
// and queues the content for the composer (pendingTemplate), which inserts it
// and selects the first {{placeholder}}.
export const templatesProvider = {
  id: "templates",
  label: "Templates",
  getResults(ctx) {
    return (ctx.templates || []).map((t) => ({
      id: `template:${t.name}`,
      icon: "template",
      title: t.name,
      subtitle: t.description || "template",
      keywords: ["template", "prompt"],
      onSelect: (ctx) => {
        ctx.setActiveView("code");
        ctx.updateComposer({ pendingTemplate: { content: t.content, ts: Date.now() } });
      },
    }));
  },
};
