import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { providerOptions, spawnProviderOptions } from "../../../lib/backendCaps.js";

// Provider switcher. For a running worker the daemon stops the current session
// and resumes it under the picked backend, reusing the session id (the resumed
// claude binary reloads the shared transcript). For the NEW-spawn composer (no
// worker selected) it picks the backend kind OR named profile the next agent
// launches on. Compatibility + at-rest checks are enforced daemon-side.
export function BackendPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "backend") return null;
  return <BackendMenu live={live} ui={ui} />;
}

function BackendMenu({ live, ui }) {
  const paneRef = useRef(null);
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  // Selected worker → live provider switch (enabled kinds). New spawn → the
  // composer's kind+profile choices; current is whichever the composer holds.
  const providers = selected ? providerOptions() : spawnProviderOptions();
  const current = selected
    ? selected.backend_kind
    : (ui.composer.backendProfile ?? ui.composer.backendKind);
  // Hover/keyboard highlight is JS-driven (the popover rows have no :hover rule —
  // .mp-row.active is the highlight). Start on the current provider. Mirrors ModelPopover.
  const [active, setActive] = useState(() =>
    Math.max(0, providers.findIndex((p) => p.value === current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (p) => {
    if (!p) { ui.closeAllPops(); return; }
    if (selected) {
      if (p.value !== current) await live.switchBackend(selected.id, p.value);
    } else {
      // A profile carries its own model (lock it); a kind uses the model picker.
      ui.updateComposer(p.type === "profile"
        ? { backendProfile: p.value, backendKind: null }
        : { backendKind: p.value, backendProfile: null });
    }
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % providers.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + providers.length) % providers.length);
    else if (e.key === "Enter" && providers[active]) pick(providers[active]);
    else if (/^[1-9]$/.test(e.key) && providers[Number(e.key) - 1]) pick(providers[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div
      className="model-popover glass-pop open"
      data-popover="backend"
      ref={paneRef}
      tabIndex={-1}
      role="menu"
      onKeyDown={onKeyDown}
    >
      <div className="mp-head">Provider</div>
      {providers.map((p, i) => {
        const on = p.value === current;
        return (
          <button
            key={p.value}
            className={"mp-row" + (on ? " on" : "") + (i === active ? " active" : "")}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
          >
            <span className="mp-name">{p.label}</span>
            {on && (
              <svg className="mp-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m2.5 8.5 3.5 3.5 7.5-8" />
              </svg>
            )}
            <span className="mp-num">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
