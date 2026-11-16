import { useLayoutEffect, useRef } from "react";
import { HighlightedName } from "./FileMenu.jsx";
import { loginState, planLabel } from "../../../components/accounts/providerMeta.js";

function AccountIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.6-2.4 2.6-3.5 5-3.5s4.4 1.1 5 3.5" />
    </svg>
  );
}

// What the right edge of a row says: where the chat is, else what stops the
// sign-in, else its plan.
function note(login, current) {
  if (login.id === current) return "current";
  return loginState(login)?.text ?? planLabel(login.plan);
}

// "/account " completion: the Claude sign-ins. Shares the @-menu's look.
export function AccountPickMenu({ logins, current, selectedIndex, onSelect, query }) {
  const listRef = useRef(null);

  useLayoutEffect(() => {
    const active = listRef.current?.querySelector(".file-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!logins.length) return null;

  return (
    <div className="cmd-menu file-menu">
      <div className="cmd-names">
        <div className="cmd-names-inner" ref={listRef}>
          {logins.map((login, i) => {
            const side = note(login, current);
            return (
              <button
                key={login.id}
                className={"file-item" + (i === selectedIndex ? " active" : "")}
                onMouseDown={(e) => { e.preventDefault(); onSelect(login); }}
              >
                <span className="file-icon"><AccountIcon /></span>
                <span className="file-name">
                  <HighlightedName name={login.label} query={query} />
                  {login.email && login.email !== login.label && (
                    <span className="file-name-dim"> · <HighlightedName name={login.email} query={query} /></span>
                  )}
                </span>
                {side && <span className="file-path">{side}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
