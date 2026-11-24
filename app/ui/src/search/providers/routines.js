import { ensureRoutinesLoaded, offeredRoutines, routinesNow } from "../../state/eos/routinesStore.js";
import { stopEos } from "../../state/eos/haltStore.js";
import { open as openRunSheet } from "../../state/eos/runSheetStore.js";
import { openEosRoute } from "../../views/eos/nav/eosNav.js";

// "Run PR Review…" for each routine that takes a run: choosing closes the
// palette and opens the run sheet centred over Eos, its item field focused
// (08 G33). "Stop everything" stops every routine on this Mac (03 G10).
export const routinesProvider = {
  id: "routines",
  label: "Routines",
  getResults() {
    ensureRoutinesLoaded();
    const runs = offeredRoutines(routinesNow().list).map((r) => ({
      id: `routine:${r.id}`,
      icon: "routine",
      title: `Run ${r.name}…`,
      subtitle: r.summary,
      keywords: [r.slug, ...(r.aliases ?? [])].filter(Boolean),
      onSelect: (ctx) => {
        openEosRoute("eos:/", ctx.setActiveView);
        openRunSheet({ routineId: r.id });
      },
    }));
    const stop = {
      id: "routine:stop-everything",
      icon: "stop",
      title: "Stop everything",
      subtitle: "Stops every routine's runs on this Mac",
      keywords: ["halt", "pause", "routines", "eos"],
      onSelect: () => { void stopEos(); },
    };
    return [...runs, stop];
  },
};
