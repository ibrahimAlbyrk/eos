import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetBlueprints, loadDraft, loadVersion, loadVersions, restoreVersion } from "../../../state/eos/blueprintStore.js";
import { _resetRoutines, loadRoutine } from "../../../state/eos/routinesStore.js";
import { _resetInbox } from "../../../state/eos/inboxStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "../nav/eosNav.js";
import { VersionCompare } from "./VersionCompare.jsx";
import { versionLine } from "./VersionMenu.jsx";
import { versionDate } from "./words.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import routinePaused from "../gallery/sample/routine-paused.json";
import versions from "../gallery/sample/blueprint-versions.json";
import bodies from "../gallery/sample/blueprint-version-bodies.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const MAIL = routinePaused.routine.id;
const [V1, V2, V3] = versions[MAIL];
const v1Body = bodies[MAIL].find((b) => b.id === V1.id);

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(sent, paths = SAMPLE_READS) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent ?? fixture.send) };
}

// Mail Triage at `location`, with its versions and version `n`'s blueprint read in.
async function screen(location, n, transport = fixtureTransport(SAMPLE_READS)) {
  setEosTransport(transport);
  await loadRoutine(MAIL);
  await loadDraft(MAIL);
  await loadVersions(MAIL);
  const row = versions[MAIL].find((r) => r.number === n);
  if (row) await loadVersion(MAIL, row.id);
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

const tabs = (html) => [...html.matchAll(/aria-selected="(true|false)"[^>]*>([^<]*)</g)].map((m) => `${m[2]}${m[1] === "true" ? "*" : ""}`);
const changedRows = (html) => [...html.matchAll(/eos-bp-row eos-bp-row--changed"><dt class="eos-bp-row__label"><span class="eos-bp-row__dot" aria-hidden="true"><\/span><span class="eos-bp-row__name">([^<]*)/g)].map((m) => m[1]);
const actions = (html) => [...(html.match(/<div class="eos-bp-actions">(.*?)<\/div>/)?.[1] ?? "").matchAll(/<button[^>]*>([^<]*)/g)].map((m) => m[1]);

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetRoutines();
  _resetInbox();
  _resetBlueprints();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the versions menu", () => {
  it("heads the card with the version shown", async () => {
    const html = await screen(`eos:/routines/${MAIL}?tab=blueprint`, 3);
    expect(html).toContain('<button type="button" class="eos-bp-card__version eos-bp-versions" aria-haspopup="menu" aria-expanded="false">Version 3, not in use yet ▾</button>');
  });

  it("lists each version with its number, date, who made it and its note", () => {
    expect(versionLine(V1)).toBe(`Version 1 · ${versionDate(V1.createdAt)} · by talking · Made by talking.`);
    expect(versionLine(V2)).toBe(`Version 2 · ${versionDate(V2.createdAt)} · you · Only the replies that matter.`);
    expect(versionLine({ ...V3, author: "eos", note: undefined })).toBe(`Version 3 · ${versionDate(V3.createdAt)} · suggested`);
  });
});

describe("an old version", () => {
  it("shows read-only with the slots that differ from the version in use marked", async () => {
    const html = await screen(`eos:/routines/${MAIL}/versions/1`, 1);
    expect(tabs(html)).toEqual(["Overview", "Runs", "Signals", "Blueprint*", "Learned"]);
    expect(html).toContain("Version 1 ▾</button>");
    expect(changedRows(html)).toEqual(["How", "Freedom"]);
    expect(html).not.toContain('class="eos-bp-value"');
    expect(actions(html)).toEqual(["Restore this version", "Compare with current", "Back to the version in use"]);
    expect(html).not.toContain("Use this version");
    expect(html).not.toContain("eos-bp-trials");
  });

  it("offers no restore for the version in use", async () => {
    const html = await screen(`eos:/routines/${MAIL}/versions/2`, 2);
    expect(changedRows(html)).toEqual([]);
    expect(actions(html)).toEqual(["Compare with current", "Back to the version in use"]);
  });

  it("says a version number the routine does not have", async () => {
    const html = await screen(`eos:/routines/${MAIL}/versions/9`, 9);
    expect(html).toContain("This routine has no such version.");
  });

  it("restores as a new version and goes back to the editor", async () => {
    const saved = { row: routinePaused.routine, versionId: "rv-restored", warnings: [] };
    const t = recording(async () => ({ ok: true, status: 200, body: saved }));
    await screen(`eos:/routines/${MAIL}/versions/1`, 1, t);
    t.get.mockClear();
    expect(await restoreVersion(MAIL, V1.id)).toBe(true);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.routineVersionRestore(MAIL, V1.id), undefined);
    expect(t.get.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([ROUTES.routine(MAIL), ROUTES.routineVersions(MAIL)]));
    expect(eosLocation()).toBe(`eos:/routines/${MAIL}/versions/1`);
  });

  it("compares each changed slot before and after", () => {
    const html = renderToStaticMarkup(<VersionCompare version={v1Body.blueprint} current={routinePaused.head.blueprint} />);
    expect(html).toContain("<th scope=\"col\">This version</th><th scope=\"col\">In use</th>");
    expect(html).toContain('<tr><th scope="row">How</th><td>Sort the mail</td><td>Sort the mail · Draft the replies that matter</td></tr>');
    expect(html).toContain('<tr><th scope="row">Freedom</th><td>Ask each time</td><td>Draft, I send</td></tr>');
    expect(renderToStaticMarkup(<VersionCompare version={v1Body.blueprint} current={v1Body.blueprint} />)).toContain("The same as the version in use.");
  });

  it("shows a version a newer Eos made, never offering to restore it", async () => {
    const newer = { ...v1Body, format: 2, runnable: false };
    const reads = { ...SAMPLE_READS, [ROUTES.routineVersion(MAIL, V1.id)]: newer };
    const html = await screen(`eos:/routines/${MAIL}/versions/1`, 1, fixtureTransport(reads));
    expect(html).toContain("A newer version of Eos made this blueprint.");
    expect(actions(html)).not.toContain("Restore this version");
  });
});
