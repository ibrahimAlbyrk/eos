import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetCapabilities, checkCapability, loadCapability, refreshCapabilities, rowOf } from "../../../state/eos/capabilitiesStore.js";
import { cancelSignIn, closeSignIn, startSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { SignInSheet } from "./SignInSheet.jsx";
import samples from "../gallery/sample/capabilities.json";

const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";
const byId = Object.fromEntries(samples.map((d) => [d.id, d]));
const reads = (details = samples) => ({
  [ROUTES.capabilities]: details.map(rowOf),
  ...Object.fromEntries(details.map((d) => [ROUTES.capability(d.id), d])),
});

function at(location) {
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

// The list's row of one capability.
const rowHtml = (html, name) => html.split('<li class="eos-cap-row">').find((part) => part.includes(`eos-cap-row__name">${name}<`));

beforeEach(() => {
  _resetCapabilities();
  _resetEosNav();
  setEosTransport(fixtureTransport(reads()));
});
afterEach(() => {
  closeSignIn();
  setEosTransport(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the Capabilities list", () => {
  it("shows each capability with its state in words, why, and the one action that fixes it", async () => {
    await refreshCapabilities();
    const html = at("eos:/capabilities");
    expect(html).toContain('<h1 class="eos-title">Capabilities</h1>');

    const expected = {
      GitHub: ["eos-status eos-status--warn\">Needs setup", "Eos has no GitHub client id to sign in with.", "Sign in"],
      SMS: ["eos-status eos-status--ok\">Ready", "Working.", null],
      Linear: ["eos-status eos-status--warn\">Needs sign-in", "The service no longer accepts its sign-in.", "Check now"],
      Weather: ["eos-status eos-status--warn\">Slow", "The service is limiting how often Eos may ask.", "Check now"],
      "RSS feeds": ["eos-status eos-status--err\">Broken", "Its answers no longer have the shape it promised.", "Check now"],
      Notify: ["eos-status\">Disabled", "You turned it off.", "Enable"],
    };
    for (const [name, [chip, line, fix]] of Object.entries(expected)) {
      const row = rowHtml(html, name);
      expect(row, name).toContain(chip);
      expect(row, name).toContain(`<span class="eos-cap-line">${line}</span>`);
      if (fix) expect(row, name).toContain(`<button type="button" class="eos-btn">${fix}</button>`);
      else expect(row, name).not.toContain('class="eos-btn');
    }
    expect(rowHtml(html, "GitHub")).toContain("Built in · Used by 1 routine");
    expect(rowHtml(html, "SMS")).toContain("Made by the Forge · Version 1.0.1 · No routine uses it");
    expect(rowHtml(html, "Weather")).toContain("From a registry · Version 1.2.0 · Used by 2 routines");
  });

  it("shows loading blocks, then an empty list or a failed read in words", async () => {
    expect(at("eos:/capabilities")).toContain('<div class="eos-skeleton" aria-busy="true" aria-label="Loading">');

    setEosTransport(fixtureTransport({}));
    await refreshCapabilities();
    expect(at("eos:/capabilities")).toContain("Couldn&#x27;t load capabilities. <button type=\"button\" class=\"eos-link\">Try again</button>");

    setEosTransport(fixtureTransport({ [ROUTES.capabilities]: [] }));
    await refreshCapabilities();
    expect(at("eos:/capabilities")).toContain("Eos has no capabilities yet.");
  });

  it("says a dev run refused the action instead of reporting a failure", async () => {
    await refreshCapabilities();
    setEosTransport({ ...fixtureTransport(reads()), send: async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: x" } }) });
    await checkCapability("weather");
    expect(at("eos:/capabilities")).toContain(`<p class="eos-note" role="status">${DEV_RUN_TEXT}</p>`);
  });
});

describe("a capability's page", () => {
  async function page(id) {
    await loadCapability(id);
    return at(`eos:/capabilities/${id}`);
  }

  it("shows what it does and reaches, its secrets as set or missing, and Sign in for GitHub", async () => {
    const html = await page("github");
    expect(html).toContain('<button type="button" class="eos-crumb">Capabilities</button>');
    expect(html).toContain('<h1 class="eos-title">GitHub</h1>');
    expect(html).toContain("Needs setup");
    expect(html).toContain("List open pull requests</span><span class=\"eos-cap-item__side\">Only reads</span>");
    expect(html).toContain("Post a review on a pull request</span><span class=\"eos-cap-item__side\">Speaks for you to others · withdraw_review takes it back</span>");
    expect(html).toContain("Cannot be taken back, or costs money");
    expect(html).toContain("<dt>Websites</dt><dd>api.github.com</dd>");
    expect(html).toContain("<dt>GitHub sign-in</dt><dd>Missing</dd>");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Sign in</button>');
    expect(html).toContain('<button type="button" class="eos-btn">Check now</button>');
    expect(html).toContain('<button type="button" class="eos-btn">Disable</button>');
    expect(html).not.toContain(">Remove<");
    expect(html).toContain("Not called yet.");
  });

  it("shows who it is signed in as, as plain text, when GitHub needs signing in again", async () => {
    setEosTransport(fixtureTransport(reads([{ ...byId.github, state: "needs_sign_in", stateCode: "http_401", accountLabel: "<b>octocat</b>" }])));
    const html = await page("github");
    expect(html).toContain("Needs sign-in");
    expect(html).toContain("Signed in as &lt;b&gt;octocat&lt;/b&gt;");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Sign in</button>');
  });

  it("shows a working capability's settings, versions and recent calls, with Remove", async () => {
    const html = await page("sms-messages");
    expect(html).toContain("Ready");
    expect(html).toContain("<dt>Apps</dt><dd>com.apple.MobileSMS</dd>");
    expect(html).toContain("<dt>Your phone number</dt><dd>+15550100</dd>");
    expect(html).toContain("Version 1.0.1</span><span class=\"eos-cap-item__side\">In use · ");
    expect(html).toContain('<button type="button" class="eos-btn">Go back to this version</button>');
    expect(html).toContain("send_sms</span><span class=\"eos-cap-item__side\">Worked · 840 ms · ");
    expect(html).toContain('<button type="button" class="eos-btn">Remove</button>');
    expect(html).not.toContain("eos-btn--primary");
    expect(html).not.toContain(">Sign in<");
  });

  it("offers going back to a kept version when it broke, never to a retired one", async () => {
    const html = await page("rss-feeds");
    expect(html).toContain("Broken");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Check now</button>');
    expect(html.match(/Go back to this version/g)).toHaveLength(1);
    expect(html).toContain("Version 1.4.0</span><span class=\"eos-cap-item__side\">Kept · ");
    expect(html).toContain("Version 1.3.0</span><span class=\"eos-cap-item__side\">Retired · ");
    expect(html).toContain("latest_items</span><span class=\"eos-cap-item__side\">Failed · 450 ms · ");
  });

  it("shows a slow one, one that needs signing in again and a disabled one with the action that fixes each", async () => {
    let html = await page("weather");
    expect(html).toContain("Slow");
    expect(html).toContain("<dt>City</dt><dd>Not set</dd>");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Check now</button>');
    expect(html).toContain("forecast</span><span class=\"eos-cap-item__side\">Took too long · 30000 ms · ");

    html = await page("linear-issues");
    expect(html).toContain("Needs sign-in");
    expect(html).toContain("<dt>Linear API key</dt><dd>Set</dd>");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Check now</button>');

    html = await page("notify");
    expect(html).toContain("Disabled");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Enable</button>');
    expect(html).toContain("Nothing outside Eos.");
    expect(html).not.toContain(">Remove<");
  });

  it("says when it could not be read, or is gone", async () => {
    setEosTransport({ get: async () => ({ ok: false, status: 500, body: { error: "x" } }), send: async () => null });
    expect(await page("weather")).toContain("Couldn&#x27;t load this capability.");
    setEosTransport(fixtureTransport({}));
    expect(await page("weather")).toContain("This capability is not here any more.");
  });
});

describe("the sign-in sheet", () => {
  const CODE = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: 1763500900000 };

  function sheetAfter(started, statuses = [], wait = 0) {
    const queue = [...statuses];
    setEosTransport({ get: async () => queue.shift(), send: async (method) => (method === "POST" ? started : { ok: true, status: 200, body: {} }) });
    return startSignIn("github").then(() => vi.advanceTimersByTimeAsync(wait)).then(() => renderToStaticMarkup(<SignInSheet />));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { open: vi.fn() });
  });

  it("is not there until a sign-in starts", () => {
    expect(renderToStaticMarkup(<SignInSheet />)).toBe("");
  });

  it("shows the code to enter, then that it waits for GitHub", async () => {
    let html = await sheetAfter({ ok: true, status: 200, body: CODE });
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="eos-sign-in-title"');
    expect(html).toContain('<p class="eos-code" aria-label="Your code">WDJB-MJHT</p>');
    expect(html).toContain("Open GitHub");
    expect(html).toContain("Copy code");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Waiting for GitHub…");

    html = await sheetAfter({ ok: true, status: 200, body: CODE }, [{ ok: true, status: 200, body: { state: "pending" } }], 2000);
    expect(html).toContain("WDJB-MJHT");
    expect(html).toContain('<p class="eos-note" role="status">Waiting for GitHub…</p>');
  });

  it("says who it signed in as once it is ready", async () => {
    const html = await sheetAfter({ ok: true, status: 200, body: CODE }, [{ ok: true, status: 200, body: { state: "signed_in", accountLabel: "octocat" } }], 2000);
    expect(html).toContain("Signed in to GitHub as octocat.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Done</button>');
    expect(html).not.toContain("WDJB-MJHT");
  });

  it("offers a new code once the old one ran out", async () => {
    const html = await sheetAfter({ ok: true, status: 200, body: CODE }, [{ ok: true, status: 200, body: { state: "expired" } }], 2000);
    expect(html).toContain("The code ran out before it was entered.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Get a new code</button>');
  });

  it("says it was cancelled, and offers to start again", async () => {
    await sheetAfter({ ok: true, status: 200, body: CODE });
    cancelSignIn();
    const html = renderToStaticMarkup(<SignInSheet />);
    expect(html).toContain("Sign-in cancelled.");
    expect(html).toContain("Start again");
    expect(html).not.toContain("WDJB-MJHT");
  });

  it("says what is missing when Eos has no GitHub client id", async () => {
    const html = await sheetAfter({ ok: false, status: 409, body: { error: "github needs setup", code: "client_id_missing" } });
    expect(html).toContain("Eos has no GitHub client id, so it cannot start a sign-in.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Close</button>');
    expect(html).not.toContain("Try again");
  });

  it("says this is a dev run", async () => {
    const html = await sheetAfter({ ok: false, status: 403, body: { error: "refused in a dev run: x" } });
    expect(html).toContain(`<p class="eos-note" role="status">${DEV_RUN_TEXT}</p>`);
  });

  it("shows any other failure's reason with Try again", async () => {
    const html = await sheetAfter({ ok: false, status: 502, body: { error: "GitHub did not answer" } });
    expect(html).toContain("GitHub did not answer");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Try again</button>');
  });
});
