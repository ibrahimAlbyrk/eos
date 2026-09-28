// accountsStore — the provider accounts (Settings › Accounts) plus any browser
// sign-in in flight, shared by every surface that shows or changes them: the
// Accounts section, the sidebar account row + menu, the first-run welcome and the
// composer's connect sheet. A module singleton (the toastStore idiom) so a
// sign-in started in one surface is the same sign-in everywhere, driven by one
// poll. Which credential an account bills is the daemon's call (`route`); the
// store only mirrors it.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { applyDescriptors, applyProfiles } from "../lib/backendCaps.js";

const POLL_MS = 1000;

// accounts: null until the first successful load. signIns: provider id → the
// SignInSession (plus a local "starting" placeholder before the daemon answers).
let state = { accounts: null, signIns: {} };
const subs = new Set();
let pollTimer = null;
let loading = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getAccountsState() {
  return state;
}

export function useAccounts() {
  return useSyncExternalStore(subscribe, getAccountsState, getAccountsState);
}

// ---- selectors --------------------------------------------------------------

export const isSignInActive = (s) => s?.state === "starting" || s?.state === "waiting";

// The account can run agents right now (a live sign-in or a key).
export const isUsable = (a) => a.route === "subscription" || a.route === "api_key";

// The small status mark every surface shows next to a provider.
export function accountTone(a) {
  if (a.route === "subscription") return "ok";
  if (a.route === "api_key") return "key";
  if (a.route === "blocked") return "expired";
  return null;
}

// Signed in to the provider's plan — live, or expired and waiting on a re-sign-in.
// The glance surfaces (account menu, sidebar row) show only these; API keys live
// in Settings › Accounts.
export const isSignedIn = (a) => a.route === "subscription" || a.route === "blocked";

// Nothing connected at all — no sign-in, no key, not even an expired one.
export const noAccountConnected = (accounts) => Boolean(accounts) && accounts.every((a) => a.route === "none");

// ---- loading ----------------------------------------------------------------

export async function refreshAccounts() {
  const accounts = await api.listAccounts().catch(() => null);
  if (accounts) set({ accounts });
}

// First load only — every surface calls this on mount; one request serves them.
export function ensureAccountsLoaded() {
  if (state.accounts || loading) return loading ?? Promise.resolve();
  loading = refreshAccounts().finally(() => { loading = null; });
  return loading;
}

// The composer's provider picker reads a non-reactive cache (lib/backendCaps.js),
// so a credential change refreshes it BEFORE the accounts emit re-renders the picker.
async function refreshProviders() {
  try {
    const cfg = await api.uiConfig();
    if (cfg) {
      applyDescriptors(cfg.backends);
      applyProfiles(cfg.backendProfiles);
    }
  } catch { /* the next ui-config load recovers */ }
}

async function afterCredentialChange() {
  await refreshProviders();
  await refreshAccounts();
}

// ---- sign-in ----------------------------------------------------------------

function setSignIn(provider, session) {
  set({ signIns: { ...state.signIns, [provider]: session } });
}

export function clearSignIn(provider) {
  if (!(provider in state.signIns)) return;
  const { [provider]: _gone, ...rest } = state.signIns;
  set({ signIns: rest });
}

const failure = (r, fallback) => r.body?.error ?? `${fallback} (HTTP ${r.status})`;

export async function startSignIn(provider) {
  setSignIn(provider, { provider, state: "starting" });
  const r = await api.startSignIn(provider).catch(() => null);
  if (!r?.ok) {
    setSignIn(provider, { provider, state: "failed", error: r ? failure(r, "Couldn't start the sign-in") : "Eos isn't reachable." });
    return;
  }
  setSignIn(provider, r.body);
  schedulePoll();
}

function schedulePoll() {
  if (!pollTimer) pollTimer = setTimeout(poll, POLL_MS);
}

async function poll() {
  pollTimer = null;
  const active = Object.values(state.signIns).filter((s) => isSignInActive(s) && s.id);
  await Promise.all(active.map(async (s) => {
    const r = await api.getSignIn(s.id).catch(() => null);
    // Superseded by a newer sign-in meanwhile — this poll's answer is stale.
    if (state.signIns[s.provider]?.id !== s.id) return;
    // A 404 means the daemon forgot the sign-in (restart); anything else is transient.
    if (r?.status === 404) {
      setSignIn(s.provider, { ...s, state: "failed", error: "The sign-in was interrupted. Try again." });
      return;
    }
    if (!r?.ok) return;
    setSignIn(s.provider, r.body);
    // Success shows as the account itself (its route); only a failure lingers.
    if (r.body.state === "succeeded") {
      await afterCredentialChange();
      clearSignIn(s.provider);
    } else if (r.body.state === "cancelled") {
      clearSignIn(s.provider);
    }
  }));
  if (Object.values(state.signIns).some((s) => isSignInActive(s) && s.id)) schedulePoll();
}

export async function cancelSignIn(provider) {
  const s = state.signIns[provider];
  clearSignIn(provider);
  if (s?.id && isSignInActive(s)) await api.cancelSignIn(s.id).catch(() => {});
}

export async function submitSignInCode(provider, code) {
  const s = state.signIns[provider];
  if (!s?.id) return { ok: false, error: "The sign-in isn't waiting for a code." };
  const r = await api.submitSignInCode(s.id, code).catch(() => null);
  if (r?.ok) return { ok: true };
  return { ok: false, error: r ? failure(r, "Couldn't send the code") : "Eos isn't reachable." };
}

export async function signOut(provider) {
  const r = await api.signOut(provider).catch(() => null);
  if (!r?.ok) return { ok: false, error: r ? failure(r, "Sign-out failed") : "Eos isn't reachable." };
  clearSignIn(provider);
  await afterCredentialChange();
  return { ok: true };
}

// ---- API keys ---------------------------------------------------------------

// Claude's key rides /api/anthropic/config. A preset's is checked live first, then
// stored in the Keychain behind a profile (/api/backends) — a bad key never lands.
export async function saveApiKey(account, key) {
  const apiKey = key.trim();
  if (!apiKey) return { ok: false, error: "Paste a key first." };
  if (account.id === "anthropic") {
    const r = await api.setAnthropicConfig({ apiKey });
    if (!r.ok) return { ok: false, error: failure(r, "Couldn't save the key") };
  } else {
    const test = await api.testBackend({ preset: account.id, apiKey });
    if (!test.ok || !test.body?.ok) return { ok: false, error: failure(test, "The key didn't work") };
    const add = await api.addBackend({ name: account.profile ?? account.id, preset: account.id, apiKey });
    if (!add.ok) return { ok: false, error: failure(add, "Couldn't save the key") };
  }
  await afterCredentialChange();
  return { ok: true };
}

export async function removeApiKey(account) {
  const r = account.id === "anthropic"
    ? await api.setAnthropicConfig({ apiKey: "" })
    : await api.deleteBackend(account.profile ?? account.id);
  if (!r.ok) return { ok: false, error: failure(r, "Couldn't remove the key") };
  await afterCredentialChange();
  return { ok: true };
}

// Test-only: reset the module singleton between cases.
export function _resetAccounts() {
  clearTimeout(pollTimer);
  pollTimer = null;
  loading = null;
  state = { accounts: null, signIns: {} };
}
