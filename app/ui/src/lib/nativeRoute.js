import { openEosRoute } from "../views/eos/nav/eosNav.js";

// A route the native app hands the window (`window.__nativeOpenRoute`): a
// notification about the user rather than a worker (e.g. memory suggestions),
// or one that names an Eos location (`eos:/…`).
export function openNativeRoute(route, { openMemory, setActiveView, openPanel }) {
  if (route === "memory") openMemory();
  if (route === "transfers") { setActiveView("agents"); openPanel("transfer"); }
  if (route?.startsWith("eos:")) openEosRoute(route, setActiveView);
}
