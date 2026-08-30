import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getBrowserPanel, patchBrowserPanel, _resetBrowserPanel } from "../../state/browserPanelStore.js";
import { BrowserTabStrip } from "./BrowserTabStrip.jsx";
import { BrowserNavBar } from "./BrowserNavBar.jsx";
import { BrowserModeButtons } from "./BrowserModeButtons.jsx";
import { BrowserDeviceMenu } from "./BrowserDeviceMenu.jsx";
import { BrowserEmptyState } from "./BrowserEmptyState.jsx";

// The chrome components take props and hold no state, so a plain call returns
// their element tree — enough to fire a real handler without a DOM. (Only
// BrowserModeButtons uses hooks; it is checked through renderToStaticMarkup.)
function nodes(tree) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    out.push(n);
    walk(n.props?.children);
  };
  walk(tree);
  return out;
}
const byLabel = (tree, label) => nodes(tree).find((n) => n.props?.["aria-label"] === label);
const stop = { stopPropagation: () => {} };
// The markup of one <button …> in isolation — attribute order is React's, so a
// slice between two labels can straddle the neighbouring button.
const buttonHtml = (html, label) => html.split("<button").find((chunk) => chunk.includes(`aria-label="${label}"`));

const TABS = [
  { tabId: "t1", url: "https://one.example/", title: "One", loading: false, canGoBack: true, canGoForward: false, audible: false, muted: false, faviconDataUri: "data:image/png;base64,AAA" },
  { tabId: "t2", url: "https://two.example/", title: "", loading: true, canGoBack: false, canGoForward: false, audible: true, muted: false, faviconDataUri: null },
];

// Enough daemon to record what the chrome asked for; the full route behaviour
// is exercised in state/browserPanelStore.test.js.
function mockDaemon() {
  const calls = [];
  const tabs = [...TABS];
  return {
    calls,
    fetchMock: vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? "GET";
      const path = new URL(url).pathname;
      calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
      if (path === "/browser/tabs" && method === "POST") {
        tabs.push({ ...TABS[0], tabId: "t3", url: "https://three.example/", title: "Three" });
        return { ok: true, status: 200, json: async () => ({ tabId: "t3" }) };
      }
      return { ok: true, status: 200, json: async () => ({ tabs, ok: true }) };
    }),
  };
}

beforeEach(() => _resetBrowserPanel());
afterEach(() => vi.unstubAllGlobals());

describe("BrowserTabStrip", () => {
  it("renders a pill per tab with its favicon, title and close ×, plus one +", () => {
    const html = renderToStaticMarkup(<BrowserTabStrip paneId="A" tabs={TABS} activeTabId="t1" />);
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain("One");
    expect(html).toContain("https://two.example/"); // titleless tab falls back to its url
    expect(html).toContain('aria-label="Close One"');
    expect(html).toContain('aria-label="New tab"');
    expect(html).toContain("browser-tab is-active"); // t1
    expect(html).toContain("is-loading"); // t2 is still loading
  });

  it("clicking a tab switches the pane's active tab", () => {
    patchBrowserPanel("A", { tabs: TABS, activeTabId: "t1" });
    const tree = BrowserTabStrip({ paneId: "A", tabs: TABS, activeTabId: "t1" });
    const pill = nodes(tree).find((n) => n.key === "t2");
    pill.props.onClick();
    expect(getBrowserPanel("A").activeTabId).toBe("t2");
  });

  it("the tab × DELETEs that tab and does not also switch to it", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    patchBrowserPanel("A", { tabs: TABS, activeTabId: "t1" });
    const tree = BrowserTabStrip({ paneId: "A", tabs: TABS, activeTabId: "t1" });
    await byLabel(tree, "Close One").props.onClick(stop);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/browser/tabs/t1" });
  });

  it("marks a sounding tab and a muted tab as distinct states", () => {
    const muted = [TABS[0], { ...TABS[1], muted: true }];
    const html = renderToStaticMarkup(<BrowserTabStrip paneId="A" tabs={muted} activeTabId="t1" />);
    expect(html).toContain("is-audible");
    expect(html).toContain("is-muted");
    expect(html).toContain('aria-label="Unmute https://two.example/"'); // titleless tab
    expect(html).toContain('aria-label="Mute One"'); // silent tab still offers the control
    const silent = renderToStaticMarkup(<BrowserTabStrip paneId="A" tabs={[TABS[0]]} activeTabId="t1" />);
    expect(silent).not.toContain("is-audible");
    expect(silent).not.toContain("is-muted");
    expect(silent).toContain("browser-tab__audio"); // rendered anyway — audible is best-effort
  });

  it("the speaker toggles that tab's mute without switching to it", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    patchBrowserPanel("A", { tabs: TABS, activeTabId: "t1" });
    const tree = BrowserTabStrip({ paneId: "A", tabs: TABS, activeTabId: "t1" });
    await byLabel(tree, "Mute https://two.example/").props.onClick(stop);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/browser/tabs/t2/mute", body: { muted: true } });
    expect(getBrowserPanel("A").activeTabId).toBe("t1"); // stopPropagation kept the tab click out
  });

  it("a muted tab's speaker asks to unmute", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    const tabs = [{ ...TABS[0], muted: true }];
    const tree = BrowserTabStrip({ paneId: "A", tabs, activeTabId: "t1" });
    await byLabel(tree, "Unmute One").props.onClick(stop);
    expect(calls[0]).toMatchObject({ path: "/browser/tabs/t1/mute", body: { muted: false } });
  });

  it("+ POSTs a new tab", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    const tree = BrowserTabStrip({ paneId: "A", tabs: TABS, activeTabId: "t1" });
    await byLabel(tree, "New tab").props.onClick();
    expect(calls[0]).toMatchObject({ method: "POST", path: "/browser/tabs", body: {} });
    expect(getBrowserPanel("A").activeTabId).toBe("t3");
  });
});

describe("BrowserNavBar", () => {
  it("disables back/forward by the daemon's history reach", () => {
    const html = renderToStaticMarkup(<BrowserNavBar paneId="A" tab={TABS[0]} urlDraft="https://one.example/" />);
    expect(buttonHtml(html, "Back")).not.toContain("disabled");
    expect(buttonHtml(html, "Forward")).toContain("disabled");
    expect(buttonHtml(html, "Reload")).not.toContain("disabled");
    expect(html).toContain("fx-search browser-url"); // the explorer's inset-well treatment
    expect(html).toContain('value="https://one.example/"');
  });

  it("submitting the address field navigates the active tab to the normalized url", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    patchBrowserPanel("A", { tabs: TABS, activeTabId: "t2" });
    const tree = BrowserNavBar({ paneId: "A", tab: TABS[1], urlDraft: "example.com" });
    const form = nodes(tree).find((n) => n.props?.onSubmit);
    let defaultPrevented = false;
    await form.props.onSubmit({ preventDefault: () => { defaultPrevented = true; } });
    expect(defaultPrevented).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/browser/tabs/t2/navigate", body: { action: "url", url: "https://example.com" } });
  });

  it("typing updates the pane's URL draft", () => {
    const tree = BrowserNavBar({ paneId: "A", tab: TABS[0], urlDraft: "" });
    const input = nodes(tree).find((n) => n.props?.className === "fx-search-input");
    input.props.onChange({ target: { value: "docs.example" } });
    expect(getBrowserPanel("A").urlDraft).toBe("docs.example");
  });

  it("back / forward / reload each dispatch their own action", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    patchBrowserPanel("A", { tabs: TABS, activeTabId: "t1" });
    const tree = BrowserNavBar({ paneId: "A", tab: TABS[0], urlDraft: "" });
    for (const label of ["Back", "Forward", "Reload"]) await byLabel(tree, label).props.onClick();
    expect(calls.filter((c) => c.path.endsWith("/navigate")).map((c) => c.body))
      .toEqual([{ action: "back" }, { action: "forward" }, { action: "reload" }]);
  });
});

describe("BrowserModeButtons", () => {
  const render = (device, mode = "view") => renderToStaticMarkup(<BrowserModeButtons paneId="A" mode={mode} device={device} />);

  // Annotate (pen), select-element (cursor) and device (phone) — reimplemented for
  // the embedded WebContentsView (hide-on-overlay annotate; native CDP inspect pick).
  it("renders the annotate, select-element and device controls with the menu closed", () => {
    const html = render("responsive");
    expect(html).toContain('aria-label="Annotate"');
    expect(html).toContain('aria-label="Select element"');
    expect(html).toContain('aria-label="Device"');
    expect(html).not.toContain("browser-device-menu");
    expect(html).not.toContain("fv-icon-btn on"); // Responsive + view → nothing lit
  });

  it("lights the phone while a device is emulated", () => {
    const html = render("mobile");
    expect(buttonHtml(html, "Device")).toContain("fv-icon-btn on");
    expect(html.match(/fv-icon-btn on/g) ?? []).toHaveLength(1);
  });

  it("lights the annotate button in annotate mode and pick in pick mode", () => {
    expect(buttonHtml(render("responsive", "annotate"), "Annotate")).toContain("fv-icon-btn on");
    expect(buttonHtml(render("responsive", "pick"), "Select element")).toContain("fv-icon-btn on");
  });
});

describe("BrowserEmptyState", () => {
  it("renders the globe, heading and subtitle — and holds no input (the address bar owns it)", () => {
    const html = renderToStaticMarkup(<BrowserEmptyState />);
    expect(html).toContain("browser-empty-state");
    expect(html).toContain("Browse and verify");
    expect(html).toContain("Enter a URL above to start");
    expect(html).toContain("<svg"); // the globe icon
    expect(html).not.toContain("<input"); // presentational only — no second URL field
  });
});

describe("BrowserDeviceMenu", () => {
  it("lists the three devices and checks exactly the active one", () => {
    const html = renderToStaticMarkup(<BrowserDeviceMenu device="mobile" onPick={() => {}} />);
    expect(html).toContain("Responsive");
    expect(html).toContain("375 × 812");
    expect(html).toContain("768 × 1024");
    expect(html.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/pr-menu-check/g) ?? []).toHaveLength(1);
  });

  it("picking an entry reports that device", () => {
    const onPick = vi.fn();
    const tree = BrowserDeviceMenu({ device: "responsive", onPick });
    const entries = nodes(tree).filter((n) => n.props?.role === "menuitemradio");
    expect(entries).toHaveLength(3);
    entries[2].props.onClick();
    expect(onPick).toHaveBeenCalledWith("tablet");
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
