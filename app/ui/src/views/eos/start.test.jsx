import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../state/eos/transport.js";
import { _resetInbox, refreshInbox } from "../../state/eos/inboxStore.js";
import { _resetRoutines, refreshRoutines } from "../../state/eos/routinesStore.js";
import { EosMain } from "./EosMain.jsx";
import { _resetEosNav, eosLocation } from "./nav/eosNav.js";
import { NavRows } from "./sidebar/NavRows.jsx";
import routines from "./gallery/sample/routines.json";
import inbox from "./gallery/sample/inbox.json";

// Each nav row as drawn: its label, whether it is selected, and its click.
const rows = vi.hoisted(() => []);
vi.mock("../agents/sidebar/NavRow.jsx", () => ({
  NavRow: (props) => {
    rows.push(props);
    return null;
  },
}));
vi.mock("../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: () => {} }));

function stubStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

beforeEach(() => {
  _resetEosNav();
  _resetInbox();
  _resetRoutines();
  rows.length = 0;
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

// Until Home arrives (P5), Eos starts on what needs the user.
describe("where Eos opens until Home", () => {
  it("is eos:/ when no place is stored, and eos:/ shows the Needs-you list", async () => {
    globalThis.localStorage = stubStorage();
    setEosTransport(fixtureTransport({ [ROUTES.inbox]: inbox, [ROUTES.routines]: routines }));
    await refreshRoutines();
    await refreshInbox();
    expect(eosLocation()).toBe("eos:/");
    const html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<h1 class="eos-title">Needs you</h1>');
    expect(html).toContain('<h2 class="eos-label">To check and send</h2>');
  });

  it("keeps a stored place", () => {
    globalThis.localStorage = stubStorage({ "eos:location": "eos:/capabilities" });
    expect(eosLocation()).toBe("eos:/capabilities");
  });

  it("selects Needs you in the sidebar, and New routine opens eos:/routines/new", () => {
    globalThis.localStorage = stubStorage();
    renderToStaticMarkup(<NavRows screen="home" />);
    expect(rows.filter((r) => r.selected).map((r) => r.label)).toEqual(["Needs you"]);
    rows.find((r) => r.label === "New routine").onClick();
    expect(eosLocation()).toBe("eos:/routines/new");
  });
});
