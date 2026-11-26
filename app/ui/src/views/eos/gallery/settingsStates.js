// The gallery's states of Settings › Eos as the app's Settings modal holds it:
// every area read, Eos stopped, the notes forgotten with their way back,
// asking before forgetting, a Mac whose doors need a step, and nothing read yet.
import { ROUTES } from "../../../api/routes.js";
import { notify } from "../../../lib/notify.js";

export const SETTINGS_READS = {
  [ROUTES.routinesSettings]: { dayBudgetUsd: 5, maxParallelRuns: 2, planHeadroomPct: 20 },
  [ROUTES.signalsSettings]: { keepAwakeForSchedules: true },
  [ROUTES.settingsAttention]: { quietOn: true, quietFrom: "22:00", quietTo: "08:00", digests: ["09:00", "17:00"], interrupts: "urgent" },
  [ROUTES.memorySettings]: { learning: true, reminders: true },
  [ROUTES.settingsSurfaces]: { textScale: 100, contrast: "normal", plain: false },
  [ROUTES.eosHalt]: { on: false },
};

const withSettings = (s) => ({ ...s, ...SETTINGS_READS });
const SINCE = Date.now() - 42 * 60 * 1000;
const press = (text) => () => [...document.querySelectorAll(".stg-body button")].find((b) => b.textContent.trim() === text)?.click();
// Brings an area of the pane into view by its label, so a plain load of the
// state shows what it is about.
const showArea = (title) => () => [...document.querySelectorAll(".stg-body .eos-label")].find((l) => l.textContent.trim().toLowerCase() === title.toLowerCase())?.scrollIntoView({ block: "start" });
const forgets = async (method, path, body) => (path === ROUTES.memoryForgetAll && body?.confirm
  ? { ok: true, status: 200, body: { forgotten: 23 } }
  : { ok: false, status: 403, body: { error: "sample data" } });

export const SETTINGS_STATES = [
  { id: "settings", label: "Settings › Eos", location: "eos:/", settings: {}, reads: withSettings },
  { id: "settings-stopped", label: "Settings › Eos · Eos stopped", location: "eos:/", settings: {}, reads: (s) => ({ ...withSettings(s), [ROUTES.eosHalt]: { on: true, since: SINCE } }) },
  { id: "settings-forget", label: "Settings › Eos · asking before forgetting", location: "eos:/", settings: {}, reads: withSettings, sends: forgets, then: press("Forget everything") },
  { id: "settings-forgotten", label: "Settings › Eos · notes forgotten", location: "eos:/", settings: {}, reads: withSettings, sends: forgets,
    then: () => { press("Forget everything")(); setTimeout(() => [...document.querySelectorAll(".eos-ask button, .stg-body button")].reverse().find((b) => b.textContent.trim() === "Forget everything")?.click(), 300); setTimeout(showArea("What leaves the Mac"), 700); } },
  { id: "settings-doors", label: "Settings › Eos · doors need a step", location: "eos:/", settings: { doors: { trusted: false, held: false, installed: false, login: "needs-approval" } }, reads: withSettings, then: showArea("Doors") },
  { id: "settings-notice", label: "Settings › Eos · a notice over the modal", location: "eos:/", settings: {}, reads: withSettings,
    then: () => notify.error("Eos could not save quiet hours. Try again in a moment.", { title: "Quiet hours not saved" }) },
  { id: "settings-loading", label: "Settings › Eos · nothing read yet", location: "eos:/", settings: {}, answer: "loading" },
];
