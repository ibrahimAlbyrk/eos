// Tells the daemon how a plugin's build fared in this window (loaded, failed to
// load, crashed) — what plugin_status hands back to the agent that wrote it.

import { api } from "../api/client.js";

// A preview window keeps its reports to itself (plugins/preview.jsx).
let sink = null;
export function setPluginReportSink(fn) {
  sink = fn;
}

export function reportPlugin(id, report) {
  if (sink) { sink(id, report); return; }
  api.reportPlugin(id, report).catch(() => {});
}
