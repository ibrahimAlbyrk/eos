import { api } from "../../api/client.js";
import { explorer } from "../../state/explorerStore.js";

// Reference "Quick actions" palette group (EOS.dc.html:2184): New task ⌘T,
// Open folder ⌘O, Search files ⌘P. Always present (no live data needed);
// selecting runs the real app action rather than a stub.
export const quickActionsProvider = {
  id: "quick",
  label: "Quick actions",
  getResults() {
    return [
      {
        id: "quick:new-task",
        icon: "newtask",
        title: "New task",
        meta: "⌘T",
        keywords: ["new", "task", "spawn", "orchestrator"],
        onSelect: (ctx) => {
          ctx.setActiveView("agents");
          ctx.setSelectedId(null);
        },
      },
      {
        id: "quick:open-folder",
        icon: "folder",
        title: "Open folder",
        meta: "⌘O",
        keywords: ["open", "folder", "directory", "project"],
        onSelect: async (ctx) => {
          ctx.setActiveView("agents");
          const r = await api.pickDirectory().catch(() => null);
          if (r?.path) {
            explorer.setRoot(r.path);
            ctx.openPanel("files");
          }
        },
      },
      {
        id: "quick:search-files",
        icon: "search",
        title: "Search files",
        meta: "⌘P",
        keywords: ["search", "files", "symbols", "find"],
        onSelect: (ctx) => {
          ctx.setActiveView("agents");
          ctx.openPanel("files");
          // Wait for the Files panel to mount+paint, then focus its search input.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => document.querySelector(".fx-search-input")?.focus()),
          );
        },
      },
    ];
  },
};
