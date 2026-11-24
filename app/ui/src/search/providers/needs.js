import { ensureInboxLoaded, inboxNow } from "../../state/eos/inboxStore.js";
import { routineRow } from "../../state/eos/routinesStore.js";
import { openEosRoute } from "../../views/eos/nav/eosNav.js";

// What waits for the user in Needs you: choosing one opens it in Eos.
export const needsProvider = {
  id: "needs",
  label: "Needs you",
  getResults() {
    ensureInboxLoaded();
    return (inboxNow().list?.items ?? []).map((item) => ({
      id: `need:${item.id}`,
      icon: "need",
      title: item.title,
      subtitle: (item.routineId && routineRow(item.routineId)?.name) ?? "Eos",
      onSelect: (ctx) => openEosRoute(`eos:/needs/${encodeURIComponent(item.id)}`, ctx.setActiveView),
    }));
  },
};
