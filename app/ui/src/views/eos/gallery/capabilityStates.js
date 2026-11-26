// Capabilities' gallery states: the list with nothing, a little and a lot,
// reading, failing and reconnecting; a capability's page in every state it
// can be in; and the sign-in sheets for GitHub's code and Slack's browser at
// each point of an attempt.

import { ROUTES } from "../../../api/routes.js";
import { resyncCapabilities, rowOf } from "../../../state/eos/capabilitiesStore.js";
import { capabilities } from "./sample/capabilitiesNow.js";

const at = (id) => `eos:/capabilities/${encodeURIComponent(id)}`;

// Slack, built in, connected to a workspace or waiting to be.
const SLACK = {
  id: "slack", name: "Slack", summary: "Reads the channels you pick and posts messages for you.", origin: "builtin", state: "ready",
  works: "any_mac", actionCount: 3, usedBy: ["rt-4k2n8q1x7m3p"], form: "builtin", accountLabel: "Acme Studio",
  actions: [
    { name: "list_conversations", summary: "List channels and people", class: "read" },
    { name: "post_message", summary: "Post a message in a channel", class: "speak", undo: "delete_message" },
    { name: "delete_message", summary: "Delete a message it posted", class: "speak" },
  ],
  reach: { hosts: ["slack.com"], apps: [], files: [] },
  secrets: [{ name: "token", label: "Slack sign-in", set: true }],
  settings: [], versions: [], recentCalls: [{ action: "post_message", outcome: "ok", at: Date.now() - 3 * 60 * 60 * 1000, durationMs: 410 }],
};

// The capabilities with `detail` added or changed, in the list and its read.
const withDetail = (detail) => (s) => {
  const list = s[ROUTES.capabilities];
  const known = list.some((r) => r.id === detail.id);
  return {
    ...s,
    [ROUTES.capability(detail.id)]: detail,
    [ROUTES.capabilities]: known ? list.map((r) => (r.id === detail.id ? rowOf(detail) : r)) : [...list, rowOf(detail)],
  };
};
const sample = (id) => capabilities.find((c) => c.id === id);
const withSlack = (change = {}) => withDetail({ ...SLACK, ...change });

// SMS with a newer version the Forge proposed, waiting for the user's yes.
const smsProposed = withDetail({
  ...sample("sms-messages"),
  versions: [{ version: "1.1.0", status: "proposed", createdAt: Date.now() - 2 * 60 * 60 * 1000, source: "rn-forge000001" }, ...sample("sms-messages").versions],
});

// Twenty-two capabilities: the samples and Slack, then sixteen more, most ready.
const MORE = [
  ["calendar", "Calendar", "Reads today's events from the Calendar app.", "script", "forge", "ready"],
  ["notion", "Notion", "Reads and writes pages in your Notion workspace.", "mcp", "registry", "ready"],
  ["figma", "Figma", "Reads frames and comments from Figma files.", "mcp", "registry", "ready"],
  ["sentry", "Sentry", "Reads new issues and their stack traces.", "mcp", "registry", "degraded"],
  ["jira", "Jira", "Reads and files tickets in Jira.", "mcp", "registry", "needs_sign_in"],
  ["unity-cloud", "Unity Cloud Build", "Starts builds and reads their logs.", "script", "forge", "ready"],
  ["app-store", "App Store Connect", "Reads reviews and build status.", "script", "forge", "ready"],
  ["mail", "Mail", "Reads and drafts mail in the Mail app.", "builtin", "builtin", "ready"],
  ["files", "Files", "Reads files in the folders you allow.", "builtin", "builtin", "ready"],
  ["web", "Web pages", "Reads web pages and their text.", "builtin", "builtin", "ready"],
  ["translate", "Translate", "Translates text between languages.", "skill", "registry", "ready"],
  ["charts", "Charts", "Draws a chart from a table.", "skill", "forge", "ready"],
  ["pdf", "PDF", "Reads text and tables out of PDF files.", "skill", "registry", "ready"],
  ["home", "Home", "Turns lights and scenes on and off.", "script", "forge", "disabled"],
  ["spotify", "Spotify", "Plays a playlist on this Mac.", "script", "synced", "available"],
  ["drive", "Google Drive", "Reads documents in a Drive folder.", "mcp", "registry", "ready"],
].map(([id, name, summary, form, origin, state]) => ({
  id, name, summary, form, origin, state, works: "any_mac", actionCount: 2, usedBy: id === "calendar" ? ["rt-2x8k5n1q6w0r"] : [],
  version: origin === "builtin" ? undefined : "1.0.0",
  ...(state === "degraded" ? { stateCode: "rate_limited" } : state === "needs_sign_in" ? { stateCode: "http_401" } : {}),
}));
const lots = (s) => {
  const withS = withSlack()(s);
  return { ...withS, [ROUTES.capabilities]: [...withS[ROUTES.capabilities], ...MORE] };
};

// Every capability ready but one turned off.
const allWell = (s) => ({
  ...s,
  [ROUTES.capabilities]: s[ROUTES.capabilities].map((r) => (r.id === "notify" ? r : { ...r, state: "ready", stateCode: undefined })),
});

// The Forge's proposal waiting in Needs you: Calendar, a capability to add.
const PROPOSAL = "ib-3c8v1b5n9m2q";
const withProposal = (s) => {
  const list = s[ROUTES.inbox];
  const item = s[ROUTES.inboxItem(PROPOSAL)].item;
  return { ...s, [ROUTES.inbox]: { ...list, items: [item, ...list.items.filter((i) => i.id !== PROPOSAL)] } };
};

// Sign-in: the page's own button pressed, the start answered by `start`, the
// attempt then read as `then`. The browser is never opened from the gallery.
const signIn = (id, start, state) => ({
  reads: (s) => {
    const next = id === "slack" ? withSlack({ state: "needs_sign_in", stateCode: "scope_missing", accountLabel: undefined, secrets: [{ name: "token", label: "Slack sign-in", set: false }] })(s) : s;
    return state ? { ...next, [ROUTES.capabilitySignIn(id)]: state } : next;
  },
  sends: async (method, path) => (path === ROUTES.capabilitySignIn(id) && method === "POST"
    ? (start === "never" ? new Promise(() => {}) : start)
    : { ok: false, status: 403, body: { error: "sample data" } }),
  then: () => {
    window.open = () => null;
    [...document.querySelectorAll(".eos-body button, .eos-head button")].find((b) => /^(Sign in|Connect)$/.test(b.textContent.trim()))?.click();
  },
});
const CODE = { ok: true, status: 200, body: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" } };
const BROWSER = { ok: true, status: 200, body: { verificationUri: "https://slack.com/oauth/v2/authorize" } };

const clickText = (text) => () => [...document.querySelectorAll("main button")].find((b) => b.textContent.trim().startsWith(text))?.click();

export const CAPABILITY_STATES = [
  { id: "capabilities-lots", label: "Capabilities · twenty-two of them", location: "eos:/capabilities", reads: lots },
  { id: "capabilities-well", label: "Capabilities · all in order", location: "eos:/capabilities", reads: allWell },
  { id: "capabilities-proposal", label: "Capabilities · the Forge proposes one", location: "eos:/capabilities", reads: withProposal },
  { id: "capabilities-loading", label: "Capabilities · loading", location: "eos:/capabilities", answer: "loading" },
  { id: "capabilities-error", label: "Capabilities · cannot read", location: "eos:/capabilities", answer: "error" },
  { id: "capabilities-offline", label: "Capabilities · reconnecting", location: "eos:/capabilities", answer: "offline", then: resyncCapabilities },
  { id: "capability-setup", label: "Capability · GitHub needs setup", location: at("github") },
  { id: "capability-ready", label: "Capability · SMS, ready, made by the Forge", location: at("sms-messages") },
  { id: "capability-proposed", label: "Capability · SMS, a new version proposed", location: at("sms-messages"), reads: smsProposed },
  { id: "capability-signin", label: "Capability · Linear needs sign-in", location: at("linear-issues") },
  { id: "capability-slow", label: "Capability · Weather, slow", location: at("weather") },
  { id: "capability-broken", label: "Capability · RSS feeds, broken", location: at("rss-feeds") },
  { id: "capability-off", label: "Capability · Notify, turned off", location: at("notify") },
  { id: "capability-slack", label: "Capability · Slack, connected", location: at("slack"), reads: withSlack() },
  {
    id: "capability-elsewhere", label: "Capability · set up on another Mac", location: at("weather"),
    reads: withDetail({ ...sample("weather"), state: "available", stateCode: undefined, origin: "synced", recentCalls: [] }),
  },
  { id: "capability-secret", label: "Capability · Linear, a secret to enter", location: at("linear-issues"), reads: withDetail({ ...sample("linear-issues"), secrets: [{ name: "api_key", label: "Linear API key", set: false }], stateCode: "secret_missing:api_key", state: "needs_setup" }) },
  { id: "capability-settings", label: "Capability · Weather, a setting changed", location: at("weather"), then: () => {
    const input = document.querySelector(".eos-body input[type=text]");
    if (!input) return;
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Istanbul");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } },
  { id: "capability-loading", label: "Capability · loading", location: at("github"), answer: "loading" },
  { id: "capability-error", label: "Capability · cannot read", location: at("github"), answer: "error" },
  { id: "capability-gone", label: "Capability · no longer here", location: at("dropbox") },
  { id: "capability-remove", label: "Capability · asked before it is removed", location: at("rss-feeds"), then: clickText("Remove") },
  { id: "signin-starting", label: "Sign-in · GitHub, asking for a code", location: at("github"), ...signIn("github", "never") },
  { id: "signin-code", label: "Sign-in · GitHub, a code to enter", location: at("github"), ...signIn("github", CODE, { state: "pending" }) },
  { id: "signin-done", label: "Sign-in · GitHub, signed in", location: at("github"), ...signIn("github", CODE, { state: "signed_in", accountLabel: "ada-lindqvist" }) },
  { id: "signin-expired", label: "Sign-in · GitHub, the code ran out", location: at("github"), ...signIn("github", CODE, { state: "expired" }) },
  { id: "signin-denied", label: "Sign-in · GitHub, told not to let Eos in", location: at("github"), ...signIn("github", CODE, { state: "denied" }) },
  { id: "signin-failed", label: "Sign-in · GitHub, did not work", location: at("github"), ...signIn("github", CODE, { state: "failed" }) },
  { id: "signin-noclient", label: "Sign-in · GitHub, no client id", location: at("github"), ...signIn("github", { ok: false, status: 409, body: { code: "client_id_missing" } }) },
  { id: "signin-slack", label: "Sign-in · Slack, allow in the browser", location: at("slack"), ...signIn("slack", BROWSER, { state: "pending" }) },
  { id: "signin-slack-done", label: "Sign-in · Slack, connected", location: at("slack"), ...signIn("slack", BROWSER, { state: "signed_in", accountLabel: "Acme Studio" }) },
];
