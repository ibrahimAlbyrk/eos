// Path input + native picker button + last-N recents below. Browser can't
// show an absolute-path directory dialog (sandbox), so we ask the daemon to
// shell out to osascript via /pick-directory.

import { useState, useMemo } from "react";
import { api } from "../../api/client.js";
import { loadRecentPaths } from "./recents.js";

export function PathField({ value, onChange, placeholder }) {
  const [picking, setPicking] = useState(false);
  // Re-read recents whenever value changes (covers the post-spawn case
  // where the modal calls pushRecentPath and immediately resets state).
  const recents = useMemo(loadRecentPaths, [value]);

  const pick = async () => {
    setPicking(true);
    try {
      const j = await api.pickDirectory();
      if (j?.path) onChange(j.path);
    } catch {} finally { setPicking(false); }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <input
          style={{ flex: 1, minWidth: 0 }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="vb-btn"
          onClick={pick}
          disabled={picking}
          title="Browse for a folder"
          style={{ flexShrink: 0 }}
        >
          Browse…
        </button>
      </div>
      {recents.length > 0 && (
        <div className="vb-recents">
          <div className="vb-recents__label">Recent</div>
          {recents.map((p) => (
            <button
              key={p}
              type="button"
              className={`vb-recent ${p === value ? "is-active" : ""}`}
              onClick={() => onChange(p)}
              title={p}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
