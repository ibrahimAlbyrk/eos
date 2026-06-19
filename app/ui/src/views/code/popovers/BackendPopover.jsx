import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { providerOptions } from "../../../lib/backendCaps.js";

// Provider switcher for a running worker. The daemon stops the current session
// and resumes it under the picked backend, reusing the session id (the resumed
// claude binary reloads the shared transcript). Compatibility + at-rest checks
// are enforced daemon-side; the composer only offers it when sensible.
export function BackendPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "backend") return null;
  return <BackendMenu live={live} ui={ui} />;
}

function BackendMenu({ live, ui }) {
  const paneRef = useRef(null);
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const current = selected?.backend_kind;
  const providers = providerOptions();
  // Hover/keyboard highlight is JS-driven (the popover rows have no :hover rule —
  // .mp-row.active is the highlight). Start on the current provider. Mirrors ModelPopover.
  const [active, setActive] = useState(() =>
    Math.max(0, providers.findIndex((p) => p.value === current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (p) => {
    if (selected && p && p.value !== current) await live.switchBackend(selected.id, p.value);
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
