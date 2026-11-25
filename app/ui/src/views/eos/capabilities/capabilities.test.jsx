import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetCapabilities, checkCapability, enterSecret, forgetSignIn, saveCapabilitySettings, installCapabilityHere, loadCapability, refreshCapabilities, rowOf } from "../../../state/eos/capabilitiesStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { cancelSignIn, closeSignIn, startSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { SignInSheet } from "./SignInSheet.jsx";
import samples from "../gallery/sample/capabilities.json";
import signInFailed from "../gallery/sample/sign-in-failed.json";

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
      SMS: ["eos-status eos-status--ok\">Ready", null, null],
      Linear: ["eos-status eos-status--warn\">Needs sign-in", "The service no longer accepts its sign-in.", "Check now"],
      Weather: ["eos-status eos-status--warn\">Slow", "The service is limiting how often Eos may ask.", "Check now"],
      "RSS feeds": ["eos-status eos-status--err\">Broken", "Its answers no longer have the shape it promised.", "Check now"],
      Notify: ["eos-status\">Disabled", "You turned it off.", "Enable"],
    };
    for (const [name, [chip, line, fix]] of Object.entries(expected)) {
      const row = rowHtml(html, name);
      expect(row, name).toContain(chip);
      if (line) expect(row, name).toContain(`<span class="eos-cap-line">${line}</span>`);
      else expect(row, name).not.toContain("eos-cap-line");
      if (fix) expect(row, name).toContain(`<button type="button" class="eos-btn">${fix}</button>`);
      else expect(row, name).not.toContain('class="eos-btn');
    }
    expect(rowHtml(html, "GitHub")).toContain("Built in · Used by 1 routine");
    expect(rowHtml(html, "SMS")).toContain("Script · Made by the Forge · Version 1.0.1 · No routine uses it");
    expect(rowHtml(html, "Weather")).toContain("MCP server · From a registry · Version 1.2.0 · Used by 2 routines");
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
    expect(html).toContain("Post a review on a pull request</span><span class=\"eos-cap-item__side\">Speaks for you to others · Withdraw review takes it back</span>");
    expect(html).toContain("Cannot be taken back, or costs money");
    expect(html).toContain("<dt>Websites</dt><dd>api.github.com</dd>");
    expect(html).toContain("<dt>GitHub sign-in</dt><dd>Missing</dd>");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Sign in</button>');
    expect(html).toContain('<button type="button" class="eos-btn">Check now</button>');
    expect(html).toContain('<button type="button" class="eos-btn">Disable</button>');
    expect(html).not.toContain(">Remove<");
    expect(html).toContain("Not called yet.");
  });

  it("offers the app's own prompt for a secret, never a field on the page, and none for a sign-in", async () => {
    const html = await page("linear-issues");
    expect(html).toContain("<dt>Linear API key</dt><dd>Set</dd>");
    expect(html).toContain('<button type="button" class="eos-btn">Replace Linear API key</button>');
    expect(html).toContain('<button type="button" class="eos-btn">Forget Linear API key</button>');
    expect(html).not.toContain("<input");
    const missing = { ...byId["linear-issues"], secrets: [{ name: "api_key", label: "Linear API key", set: false }] };
    setEosTransport(fixtureTransport(reads([missing])));
    const asked = await page("linear-issues");
    expect(asked).toContain('<button type="button" class="eos-btn eos-btn--primary">Enter Linear API key</button>');
    expect(asked).not.toContain(">Forget Linear API key<");
    expect(await page("github")).not.toContain(">Enter GitHub sign-in<");
  });

  it("asks the core to open the prompt and reloads the page once a secret was kept", async () => {
    const sent = [];
    const get = vi.fn(fixtureTransport(reads()).get);
    const send = async (method, path, body) => {
      sent.push([method, path, body]);
      return { ok: true, status: 200, body: { stored: true } };
    };
    setEosTransport({ get, send });
    await enterSecret("linear-issues", "api_key");
    expect(sent).toEqual([["POST", "/api/capabilities/linear-issues/secrets/api_key", {}]]);
    expect(get).toHaveBeenCalledWith(ROUTES.capability("linear-issues"));
  });

  it("shows who it is signed in as, as plain text, when GitHub needs signing in again", async () => {
    setEosTransport(fixtureTransport(reads([{ ...byId.github, state: "needs_sign_in", stateCode: "http_401", accountLabel: "<b>octocat</b>" }])));
    const html = await page("github");
    expect(html).toContain("Needs sign-in");
    expect(html).toContain("Signed in as &lt;b&gt;octocat&lt;/b&gt;");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Sign in</button>');
  });

  it("offers Forget sign-in once GitHub is signed in, and names the routines that use it", async () => {
    _resetRoutines();
    const github = { ...byId.github, state: "ready", stateCode: undefined, accountLabel: "octocat", secrets: [{ name: "token", label: "GitHub sign-in", set: true }] };
    setEosTransport(fixtureTransport({ ...reads([github]), [ROUTES.routines]: [{ id: "rt-4k2n8q1x7m3p", name: "PR Review" }] }));
    let html = await page("github");
    expect(html).toContain('<button type="button" class="eos-btn">Forget sign-in</button>');
    expect(html).toContain("Used by 1 routine");
    await refreshRoutines();
    html = at("eos:/capabilities/github");
    expect(html).toContain("Used by PR Review · Signed in as octocat");
    expect(await page("sms-messages")).not.toContain(">Forget sign-in<");
    _resetRoutines();
  });

  it("forgets every secret a sign-in kept, then reads the capability again", async () => {
    const sent = [];
    const get = vi.fn(fixtureTransport(reads()).get);
    const send = async (method, path) => {
      sent.push([method, path]);
      return { ok: true, status: 200, body: { ok: true } };
    };
    setEosTransport({ get, send });
    await forgetSignIn({ id: "github", secrets: [{ name: "token", set: true }, { name: "other", set: false }] });
    expect(sent).toEqual([["DELETE", "/api/capabilities/github/secrets/token"]]);
    expect(get).toHaveBeenCalledWith(ROUTES.capability("github"));
  });

  it("saves typed settings and shows the detail the core answers, a choice as its choices", async () => {
    const sent = [];
    const saved = { ...byId.weather, settings: [{ name: "city", label: "City", kind: "text", value: "Izmir" }, { name: "units", label: "Units", kind: "choice", choices: ["metric", "imperial"] }] };
    const get = fixtureTransport(reads()).get;
    setEosTransport({ get, send: async (method, path, body) => { sent.push([method, path, body]); return { ok: true, status: 200, body: saved }; } });
    expect(await saveCapabilitySettings("weather", { city: "Izmir" })).toBe(true);
    expect(sent).toEqual([["PUT", ROUTES.capabilitySettings("weather"), { values: { city: "Izmir" } }]]);
    const html = at("eos:/capabilities/weather");
    expect(html).toContain('value="Izmir"');
    expect(html).toContain('<option value="" selected="">Not set</option><option value="metric">metric</option><option value="imperial">imperial</option>');
  });

  it("says it is reconnecting when the core stops answering, and keeps what it read", async () => {
    await refreshCapabilities();
    setEosTransport({ get: async () => { throw new Error("gone"); }, send: async () => null });
    await refreshCapabilities();
    const html = at("eos:/capabilities");
    expect(html).toContain('<p class="eos-cap-offline" role="status">Reconnecting…</p>');
    expect(html).toContain('eos-cap-row__name">GitHub<');
    setEosTransport(fixtureTransport(reads()));
    await refreshCapabilities();
    expect(at("eos:/capabilities")).not.toContain("Reconnecting…");
  });

  it("shows a working capability's settings, versions and recent calls, with Remove", async () => {
    const html = await page("sms-messages");
    expect(html).toContain("Ready");
    expect(html).toContain("<dt>Apps</dt><dd>com.apple.MobileSMS</dd>");
    expect(html).toContain('<span>Your phone number</span><input type="tel" placeholder="Not set" value="+15550100"/>');
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
    expect(html).toContain('<span>City</span><input type="text" placeholder="Not set" value=""/>');
    expect(html).toContain('<button type="submit" class="eos-btn" disabled="">Save settings</button>');
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

  it("offers to install here one that arrived from another Mac, and asks the core to", async () => {
    const synced = { ...byId.weather, id: "weather", origin: "synced", state: "available", stateCode: null };
    const sent = [];
    const transport = fixtureTransport(reads([synced]));
    transport.send = async (method, path, body) => {
      sent.push([method, path, body]);
      return { ok: true, status: 200, body: { ...rowOf(synced), state: "needs_setup" } };
    };
    setEosTransport(transport);
    const html = await page("weather");
    expect(html).toContain("It is set up on another Mac. Install it here to use it on this one.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Install on this Mac</button>');
    expect(html).not.toContain(">Check now<");
    await installCapabilityHere("weather");
    expect(sent).toEqual([["POST", ROUTES.capabilityInstallHere("weather"), {}]]);
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

  function sheetAfter(started, statuses = [], wait = 0, id = "github") {
    const queue = [...statuses];
    setEosTransport({ get: async () => queue.shift(), send: async (method) => (method === "POST" ? started : { ok: true, status: 200, body: {} }) });
    return startSignIn(id).then(() => vi.advanceTimersByTimeAsync(wait)).then(() => renderToStaticMarkup(<SignInSheet />));
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
    const html = await sheetAfter({ ok: false, status: 409, body: { error: "GitHub has no client id to sign in with", code: "client_id_missing" } });
    expect(html).toContain("Eos has no GitHub client id, so it cannot start a sign-in.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Close</button>');
    expect(html).not.toContain("Try again");
  });

  it("connects Slack in the browser: no code to type, Allow there, then connected to the workspace", async () => {
    const page = { verificationUri: "https://slack.com/oauth/v2/authorize?client_id=1&state=s", expiresAt: 1 };
    let html = await sheetAfter({ ok: true, status: 200, body: page }, [], 0, "slack");
    expect(html).toContain("Connect Slack");
    expect(html).toContain("Pick your workspace and press Allow");
    expect(html).toContain("You never type or paste a password or a key.");
    expect(html).toContain("Open Slack again");
    expect(html).not.toContain("eos-code");
    expect(window.open).toHaveBeenCalledWith(page.verificationUri, "_blank", "noopener,noreferrer");

    html = await sheetAfter({ ok: true, status: 200, body: page }, [{ ok: true, status: 200, body: { state: "pending" } }], 2000, "slack");
    expect(html).toContain('<p class="eos-note" role="status">Waiting for Slack…</p>');
    html = await sheetAfter({ ok: true, status: 200, body: page }, [{ ok: true, status: 200, body: { state: "signed_in", accountLabel: "Acme as ibrahim" } }], 2000, "slack");
    expect(html).toContain("Connected to Acme as ibrahim.");
  });

  it("says Slack was refused or never sent the user back, and offers to connect again", async () => {
    const page = { verificationUri: "https://slack.com/oauth/v2/authorize?client_id=1&state=s", expiresAt: 1 };
    let html = await sheetAfter({ ok: true, status: 200, body: page }, [{ ok: true, status: 200, body: { state: "denied" } }], 2000, "slack");
    expect(html).toContain("Slack was told not to let Eos in.");
    html = await sheetAfter({ ok: true, status: 200, body: page }, [{ ok: true, status: 200, body: { state: "expired" } }], 2000, "slack");
    expect(html).toContain("Slack did not send you back in time.");
    expect(html).toContain(">Connect again</button>");
    html = await sheetAfter({ ok: false, status: 409, body: { error: "Slack has no client id to sign in with", code: "client_id_missing" } }, [], 0, "slack");
    expect(html).toContain("Set slack.clientId in Eos");
  });

  it("says this is a dev run", async () => {
    const html = await sheetAfter({ ok: false, status: 403, body: { error: "refused in a dev run: x" } });
    expect(html).toContain(`<p class="eos-note" role="status">${DEV_RUN_TEXT}</p>`);
  });

  it("stops waiting when the sign-in did not work, and offers to try again", async () => {
    const html = await sheetAfter({ ok: true, status: 200, body: CODE }, [{ ok: true, status: 200, body: { state: "pending" } }, { ok: true, status: 200, body: signInFailed }], 4000);
    expect(html).toContain('<p class="eos-note" role="status">The sign-in did not work.</p>');
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Try again</button>');
    expect(html).not.toContain("Waiting for GitHub…");
    expect(html).not.toContain("WDJB-MJHT");
  });

  it("says the sign-in did not work when GitHub gave no code", async () => {
    const html = await sheetAfter({ ok: false, status: 502, body: { error: "unreachable: github" } });
    expect(html).toContain("The sign-in did not work. GitHub did not give Eos a code.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Try again</button>');
  });

  it("shows any other failure's reason with Try again", async () => {
    const html = await sheetAfter({ ok: false, status: 404, body: { error: "capability sign-in not found: linear" } });
    expect(html).toContain("capability sign-in not found: linear");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Try again</button>');
  });

  it("says Eos could not start it when the core answered without a reason", async () => {
    const html = await sheetAfter({ ok: false, status: 500, body: null });
    expect(html).toContain('<p class="eos-note" role="status">Eos could not start the sign-in.</p>');
    expect(html).not.toContain("Eos isn&#x27;t reachable.");
  });
});
