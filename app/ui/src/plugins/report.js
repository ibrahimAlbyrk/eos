// Tells the daemon how a plugin's build fared in this window (loaded, failed to
// load, crashed) — what plugin_status hands back to the agent that wrote it.

import { api } from "../api/client.js";

export function reportPlugin(id, report) {
  api.reportPlugin(id, report).catch(() => {});
}
