// "View changes" — opens the git diff viewer for the selected agent.
export const changesProvider = {
  id: "git",
  label: "Git",
  getResults(ctx) {
    if (!ctx.selectedId) return [];
    return [{
      id: "git:view-changes",
      icon: "diff",
      title: "View changes",
      subtitle: "working tree diff",
      keywords: ["diff", "git", "changes", "patch"],
      onSelect: (c) => {
        c.setActiveView("code");
        c.openDiffViewer(c.selectedId);
      },
    }];
  },
};
