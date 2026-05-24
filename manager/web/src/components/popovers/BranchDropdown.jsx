import { useEffect, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";

export function BranchDropdown({ live, cwd }) {
  const ui = useUi();
  const [branches, setBranches] = useState([]);
  const [current, setCurrent] = useState(null);
  const [filter, setFilter] = useState("");

  const draft = ui.drafts.get(ui.selectedId);
  const composerBranch = (draft ?? ui.composer).branch;
  const setBranch = (b) => {
    if (draft) ui.updateDraft(ui.selectedId, { branch: b });
    else ui.updateComposer({ branch: b });
  };

  useEffect(() => {
    if (ui.openPopover !== "branch-dd" || !cwd) return;
    (async () => {
      const r = await api.listBranches(cwd);
      setBranches(r.branches ?? []);
      setCurrent(r.current ?? null);
      if (!composerBranch && r.current) setBranch(r.current);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.openPopover, cwd]);

  if (ui.openPopover !== "branch-dd") return null;

  const pick = async (b) => {
    if (cwd && b !== current) {
      try { await api.checkout(cwd, b); } catch {}
    }
    setBranch(b);
    ui.closeAllPops();
  };

  const filtered = filter
    ? branches.filter((b) => b.toLowerCase().includes(filter.toLowerCase()))
    : branches;

  return (
    <div className="cb-chip-dd open" id="cbBranchDD" data-popover="branch-dd">
      {filtered.length === 0 && (
        <div style={{ padding: "10px 12px", color: "var(--fg-faint)", fontSize: 12 }}>
          {cwd ? "No branches found" : "Pick a folder first"}
        </div>
      )}
      {filtered.map((b) => (
        <button
          key={b}
          className={"sp-chip-dd-item" + ((composerBranch ?? current) === b ? " on" : "")}
          onClick={() => pick(b)}
        >
          <span>{b}</span>
          <span className="check">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m4 8 3 3 5-6" />
            </svg>
          </span>
        </button>
      ))}
      <div className="cb-branch-search">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="5" /><path d="m13 13-2.5-2.5" />
        </svg>
        <input
          placeholder="Search branches…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
    </div>
  );
}
