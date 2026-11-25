import { api } from "../api/client.js";
import { isListedAgent } from "./agentIndex.js";
import { openEosRoute } from "../views/eos/nav/eosNav.js";

// Opens what a job, a banner or an ask names by worker id: a chat in Agents,
// or, for an agent working for a routine's run (never in the Agents list), that
// run's view in Eos. An id neither knows opens Agents on it, as before.
export async function openAgent(workerId, { setActiveView, selectAgent }) {
  if (!isListedAgent(workerId)) {
    const found = await api.findRunAgent(workerId).catch(() => null);
    if (found) {
      openEosRoute(`eos:/runs/${encodeURIComponent(found.runId)}`, setActiveView);
      return;
    }
  }
  setActiveView("agents");
  selectAgent(workerId);
}
