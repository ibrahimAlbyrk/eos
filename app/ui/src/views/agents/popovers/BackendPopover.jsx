import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { providerChoices, providerName, providerSwitchTargets, runningProviderChoice, usesClaudeCatalog } from "../../../lib/backendCaps.js";
import { MODELS, modelName } from "../../../lib/models.js";
import { api } from "../../../api/client.js";
import { useProviderModels } from "../../../hooks/useProviderModels.js";
import { useSettings } from "../../../state/settings.jsx";
import { useAccounts, isUsable } from "../../../state/accountsStore.js";
import { openConnectSheet } from "../../../state/connectSheetStore.js";
import { metaFor, accountMatchesChoice, choiceReady } from "../../../components/accounts/providerMeta.js";

const DEFAULT_CLAUDE_MODEL = "opus";
const isClaudeModel = (m) => Boolean(m) && (MODELS.some((e) => e.id === m || e.aliases.includes(m)) || /^(claude-|opus|sonnet|haiku|fable)/.test(m));

// Provider switcher. Two distinct modes:
//   • a selected worker → live provider switch (the daemon stops + resumes the
//     session under the picked backend KIND, reusing the session id);
//   • the NEW-spawn composer → the unified provider picker over providerChoices()
//     (subscription kinds + the operator's configured API profiles). Picking one
//     sets composer.provider + defaults the model to a profile's pinned model. The
//     model itself is chosen from the SEPARATE model pill — the Claude catalog
//     (ModelPopover) for a subscription provider, this SpawnModelPopover for an API
//     profile.
export function BackendPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "backend") return null;
  // This pane's own worker (not the global selection) — the switch targets +
  // action must apply to THIS pane's agent, not the selected one.
  const selected = worker ?? null;
  return selected ? <BackendSwitchMenu live={live} ui={ui} selected={selected} /> : <SpawnBackendMenu ui={ui} />;
}

// Live provider switch for a running worker — the SAME configured providers as the
// new-spawn picker (providerSwitchTargets over providerChoices), never a raw kind.
// Targets the daemon can't hand off to (a different conversation store) are greyed
// with the reason; the switch routes by the choice's backend kind.
function BackendSwitchMenu({ live, ui, selected }) {
  const paneRef = useRef(null);
  const targets = providerSwitchTargets(selected.backend_kind);
  const [active, setActive] = useState(() => Math.max(0, targets.findIndex((p) => p.current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (p) => {
    if (!p || p.disabled) return;
    if (!p.current) await live.switchBackend(selected.id, p.kind);
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % targets.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + targets.length) % targets.length);
    else if (e.key === "Enter" && targets[active]) pick(targets[active]);
    else if (/^[1-9]$/.test(e.key) && targets[Number(e.key) - 1]) pick(targets[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      <div className="mp-scroll">
        {targets.map((p, i) => (
          <button
            key={p.name}
            className={"mp-row" + (p.current ? " on" : "") + (i === active ? " active" : "") + (p.disabled ? " disabled" : "")}
            disabled={p.disabled}
            title={p.disabled ? p.reason : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
          >
            <span className="mp-name">{providerName(p)}</span>
            {p.current && <CheckIcon />}
            <span className="mp-num">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// New-spawn provider picker over providerChoices(). Picking one sets
// composer.provider (resolved to backendKind/backendProfile at spawn) and defaults
// the model to a profile's pinned model; the model is then refined from the
// separate model pill. A subscription provider that can't run yet (not connected,
// or its sign-in expired) shows Connect instead: it opens the Connect sheet, which
// selects the provider once it is connected — the typed task stays put.
function SpawnBackendMenu({ ui }) {
  const paneRef = useRef(null);
  const { openSettings } = useSettings();
  const { accounts } = useAccounts();
  const choices = providerChoices();
  const current = ui.composer.provider;
  const accountFor = (c) => (accounts ?? []).find((a) => accountMatchesChoice(a, c)) ?? null;
  const items = [];
  for (const c of choices) {
    const a = accountFor(c);
    // Signed in to the plan → the plan's lane replaces the account's API-key
    // profile (the Accounts rule: signed in → subscription, always).
    if (!c.subscription && a?.route === "subscription") continue;
    items.push({ key: c.name, choice: c, connect: a && !choiceReady(c, a) ? a : null });
  }
  // Plan providers with no lane in the list at all (e.g. its CLI isn't installed) still offer Connect.
  for (const a of accounts ?? []) {
    if (a.subscription && !isUsable(a) && !choices.some((c) => accountMatchesChoice(a, c))) {
      items.push({ key: `connect:${a.id}`, choice: null, connect: a });
    }
  }
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((it) => it.choice?.name === current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  // A profile's pinned model becomes the default; a lane with its own catalog
  // starts on the first (default) model it lists; a Claude lane never keeps a
  // model carried over from another provider.
  const select = (c) => {
    const patch = { provider: c.name };
    if (c.model) patch.model = c.model;
    else if (usesClaudeCatalog(c) && !isClaudeModel(ui.composer.model)) patch.model = DEFAULT_CLAUDE_MODEL;
    ui.updateComposer(patch);
    if (!c.model && !usesClaudeCatalog(c)) {
      api.listBackendModels(c.name).then((r) => { if (r.models?.[0]) ui.updateComposer({ model: r.models[0] }); });
    }
  };

  const pick = (item) => {
    ui.closeAllPops();
    if (item.connect) {
      const choice = item.choice;
      openConnectSheet(item.connect.id, {
        ready: (account) => (choice ? choiceReady(choice, account) : isUsable(account)),
        onConnected: (account) => {
          const ready = providerChoices()
            .filter((c) => accountMatchesChoice(account, c) && choiceReady(c, account))
            .sort((a, b) => Number(b.subscription) - Number(a.subscription));
          if (ready[0]) select(ready[0]);
        },
      });
      return;
    }
    select(item.choice);
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % items.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + items.length) % items.length);
    else if (e.key === "Enter" && items[active]) pick(items[active]);
    else if (/^[1-9]$/.test(e.key) && items[Number(e.key) - 1]) pick(items[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover mp-accounts open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      <div className="mp-scroll">
        {items.map((it, i) => (
          <button
            key={it.key}
            className={"mp-row" + (it.choice?.name === current && !it.connect ? " on" : "") + (i === active ? " active" : "")}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(it)}
          >
            <span className="mp-name">{it.choice ? providerName(it.choice) : metaFor(it.connect).name}</span>
            {it.connect && <span className="mp-connect">{it.connect.route === "none" ? "Connect" : "Sign in"}</span>}
            {!it.connect && it.choice?.name === current && <CheckIcon />}
            <span className="mp-num">{i + 1}</span>
          </button>
        ))}
      </div>
      <div className="mp-sep" />
      <button className="mp-row mp-manage" onClick={() => { ui.closeAllPops(); openSettings("accounts"); }}>
        <span className="mp-name">Manage accounts…</span>
      </button>
    </div>
  );
}

// Model picker for an API-profile provider — used both by the new-spawn composer
// and by a RUNNING API worker (its provider's models aren't the Claude catalog, so
// this replaces the Claude ModelPopover for that lane). Lazily fetches the
// provider's /v1/models (useProviderModels), fail-soft to its pinned model so the
// list is never a dead end. A subscription provider uses the Claude ModelPopover
// instead, never this. Picking a model: a running worker → live setModel (persists
// for the next turn); the new-spawn composer → the composer model override.
export function SpawnModelPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "spawnModel") return null;
  return <SpawnModelMenu ui={ui} live={live} worker={worker ?? null} />;
}

function SpawnModelMenu({ ui, live, worker }) {
  const paneRef = useRef(null);
  // A running worker sources its OWN configured provider + model; the new-spawn
  // composer sources the composer's chosen provider + model.
  const providerNm = worker ? (runningProviderChoice(worker)?.name ?? null) : ui.composer.provider;
  const currentModel = worker?.model ?? ui.composer.model;
  const { loading, models, error } = useProviderModels(providerNm);
  const [active, setActive] = useState(0);

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (m) => {
    if (worker) await live.setModel(worker.id, m, worker.effort ?? ui.composer.effort);
    else ui.updateComposer({ model: m });
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "Escape") ui.closeAllPops();
    else if (!models.length) handled = false;
    else if (e.key === "ArrowDown") setActive((i) => (i + 1) % models.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + models.length) % models.length);
    else if (e.key === "Enter" && models[active]) pick(models[active].id);
    else if (/^[1-9]$/.test(e.key) && models[Number(e.key) - 1]) pick(models[Number(e.key) - 1].id);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover open" data-popover="spawnModel" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Model</div>
      <div className="mp-scroll">
        {loading && <div className="mp-sub mp-muted">Loading models…</div>}
        {!loading && models.map((m, i) => {
          const on = m.id === currentModel;
          return (
            <button
              key={m.id}
              className={"mp-row" + (on ? " on" : "") + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m.id)}
            >
              <span className="mp-name">{m.name || modelName(m.id) || m.id}</span>
              {on && <CheckIcon />}
              <span className="mp-num">{i + 1}</span>
            </button>
          );
        })}
        {!loading && error && <div className="mp-sub mp-muted mp-err">{error}</div>}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg className="mp-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m2.5 8.5 3.5 3.5 7.5-8" />
    </svg>
  );
}
