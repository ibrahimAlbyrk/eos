import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../api/routes.js";
import { fixtureTransport, setEosTransport } from "../state/eos/transport.js";
import {
  _resetEosSettings, changeEosSetting, forgetAllLearned, loadEosSettings, sendTestPush, undoForgetAll,
} from "../state/eos/eosSettingsStore.js";
import { _resetHalt, loadHalt, stopEos } from "../state/eos/haltStore.js";
import { probeEosStatus } from "../state/eos/eosStatusStore.js";
import { EosSettings } from "./EosSettings.jsx";
import { visibleSections } from "./registry.jsx";

const READS = {
  [ROUTES.routinesSettings]: { dayBudgetUsd: 5, maxParallelRuns: 2, planHeadroomPct: 20 },
  [ROUTES.signalsSettings]: { keepAwakeForSchedules: false },
  [ROUTES.settingsAttention]: { quietOn: true, quietFrom: "22:00", quietTo: "08:00", digests: ["09:00", "17:00"], interrupts: "urgent" },
  [ROUTES.memorySettings]: { learning: true, reminders: false },
  [ROUTES.settingsSurfaces]: { textScale: 115, contrast: "normal", plain: false },
  [ROUTES.eosHalt]: { on: false },
};

// Writes answer what a core would: the settings as they are after the write.
function core() {
  const fixture = fixtureTransport(READS);
  const send = vi.fn(async (method, path, body) => {
    if (path === ROUTES.routinesSettings) return { ok: true, status: 200, body: { ...READS[path], ...body } };
    if (path === ROUTES.eosHalt) return { ok: true, status: 200, body: { on: true, since: 1 } };
    if (path === ROUTES.memoryForgetAll) return { ok: true, status: 200, body: body.confirm ? { forgotten: 7 } : { restored: 7 } };
    if (path === ROUTES.remotePushTest) return { ok: true, status: 200, body: { sent: 1, failed: 0 } };
    return { ok: true, status: 200, body };
  });
  setEosTransport({ get: fixture.get, send });
  return send;
}

const row = (html, label) => html.split('<div class="stg-row">').find((part) => part.includes(`stg-row__label">${label}<`));

beforeEach(() => {
  _resetEosSettings();
  _resetHalt();
});
afterEach(() => {
  setEosTransport(null);
  vi.unstubAllGlobals();
});

describe("Settings › Eos", () => {
  it("shows each area's settings as its route reads them, then Remote, Privacy and Stop everything", async () => {
    core();
    await Promise.all([loadEosSettings(), loadHalt()]);
    const html = renderToStaticMarkup(<EosSettings />);
    const groups = [...html.matchAll(/stg-group__title">([^<]+)</g)].map((m) => m[1]);
    expect(groups).toEqual(["Routines", "What interrupts you", "Memory", "Pages", "Remote", "Privacy", "Stop"]);
    expect(row(html, "Daily limit for all routines")).toContain('value="5"');
    expect(row(html, "Keep the Mac awake for schedules")).toContain('aria-checked="false"');
    expect(row(html, "What may interrupt")).toContain('<option value="urgent" selected="">');
    expect(row(html, "Quiet hours")).toContain("Digests come at 09:00, 17:00.");
    expect(row(html, "Quiet hours")).toContain('value="22:00"');
    expect(row(html, "Learning")).toContain('aria-checked="true"');
    expect(row(html, "Reminders")).toContain('aria-checked="false"');
    expect(row(html, "Text size")).toContain('<option value="115" selected="">115 %</option>');
    expect(row(html, "More contrast")).toContain('aria-checked="false"');
    expect(row(html, "Plain reading")).toContain('aria-checked="false"');
    expect(row(html, "What leaves the Mac")).toContain("Text inside pull requests, mails or web pages never becomes a note.");
    expect(row(html, "Forget everything learned")).toContain(">Forget everything</button>");
    expect(row(html, "Export what was learned")).toContain(">Export</button>");
    expect(row(html, "Stop everything")).toContain(">Stop everything</button>");
  });

  it("offers Start at login through the shell's door, and leaves Doors out in a browser tab", async () => {
    core();
    await loadEosSettings();
    expect(renderToStaticMarkup(<EosSettings />)).not.toContain(">Doors<");
    vi.stubGlobal("window", { eosDoors: { loginItem: vi.fn(() => new Promise(() => {})), setLoginItem: vi.fn() } });
    expect(renderToStaticMarkup(<EosSettings />)).toContain(">Doors<");
  });

  it("writes each setting through its own route: the limit's changed field, the others whole", async () => {
    const send = core();
    await loadEosSettings();
    await changeEosSetting("routines", { dayBudgetUsd: 8 });
    await changeEosSetting("memory", { learning: false });
    await changeEosSetting("signals", { keepAwakeForSchedules: true });
    await changeEosSetting("attention", { interrupts: "none" });
    await changeEosSetting("surfaces", { contrast: "more" });
    expect(send.mock.calls).toEqual([
      ["PUT", ROUTES.routinesSettings, { dayBudgetUsd: 8 }],
      ["PUT", ROUTES.memorySettings, { learning: false, reminders: false }],
      ["PUT", ROUTES.signalsSettings, { keepAwakeForSchedules: true }],
      ["PUT", ROUTES.settingsAttention, { ...READS[ROUTES.settingsAttention], interrupts: "none" }],
      ["PUT", ROUTES.settingsSurfaces, { ...READS[ROUTES.settingsSurfaces], contrast: "more" }],
    ]);
    const html = renderToStaticMarkup(<EosSettings />);
    expect(row(html, "Daily limit for all routines")).toContain('value="8"');
    expect(row(html, "Learning")).toContain('aria-checked="false"');
    expect(row(html, "More contrast")).toContain('aria-checked="true"');
  });

  it("forgets everything learned with an undo, sends a test notification, and stops everything", async () => {
    const send = core();
    await loadEosSettings();
    await forgetAllLearned();
    expect(row(renderToStaticMarkup(<EosSettings />), "Forget everything learned")).toContain("Forgot 7 notes. You can bring them back for 30 days.");
    await undoForgetAll();
    expect(row(renderToStaticMarkup(<EosSettings />), "Forget everything learned")).toContain(">Forget everything</button>");
    expect(await sendTestPush()).toBe("Sent to your iPhone.");
    expect(await stopEos()).toBe(true);
    expect(row(renderToStaticMarkup(<EosSettings />), "Stop everything")).toContain(">Resume</button>");
    expect(send.mock.calls.map(([method, path, body]) => [method, path, body])).toEqual([
      ["POST", ROUTES.memoryForgetAll, { confirm: true }],
      ["POST", ROUTES.memoryForgetAll, { undo: true }],
      ["POST", ROUTES.remotePushTest, {}],
      ["POST", ROUTES.eosHalt, {}],
    ]);
  });

  it("is a section of Settings only while Eos is shown", async () => {
    setEosTransport(fixtureTransport({}));
    await probeEosStatus();
    expect(visibleSections({}).map((s) => s.id)).not.toContain("eos");
    setEosTransport(fixtureTransport({ [ROUTES.routines]: [] }));
    await probeEosStatus();
    expect(visibleSections({}).map((s) => s.id)).toContain("eos");
  });
});
