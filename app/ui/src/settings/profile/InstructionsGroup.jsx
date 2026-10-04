import { useState } from "react";
import { api } from "../../api/client.js";
import { CONTROLS } from "../controls.jsx";

const Textarea = CONTROLS.textarea;
const MAX = 4000;

// Standing instructions — Eos-owned, delivered to every agent on every provider.
// "Import from CLAUDE.md" copies the user-level file in once (CLAUDE.md itself is
// never written; lines an agent already gets from it are skipped at render time).
export function InstructionsGroup({ profile, onSave }) {
  const [note, setNote] = useState(null);
  const text = profile.instructions;

  const importClaudeMd = async () => {
    const r = await api.importClaudeMd();
    if (!r?.text?.trim()) { setNote("No user-level CLAUDE.md found."); return; }
    const merged = text.trim() ? `${text.trim()}\n\n${r.text.trim()}` : r.text.trim();
    onSave({ instructions: merged.slice(0, MAX) });
    setNote(`Imported from ${r.path}`);
  };

  return (
    <div className="stg-group">
      <div className="stg-group__title prof-group-title">
        <span>Standing instructions</span>
        <button type="button" className="prof-link-btn" onClick={importClaudeMd}>Import from CLAUDE.md</button>
      </div>
      <div className="stg-row stg-row--stack">
        <Textarea
          value={text}
          onChange={(v) => onSave({ instructions: v })}
          rows={6}
          maxLength={MAX}
          placeholder="e.g. Be concise. Ask before big refactors. Prefer small, surgical diffs."
        />
        <div className="prof-instr-foot">
          <span>{note ?? "Every agent, every provider, every project"}</span>
          <span className="mono">{Math.ceil(text.length / 4)} tokens</span>
        </div>
      </div>
    </div>
  );
}
