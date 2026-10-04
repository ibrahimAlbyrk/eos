import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { CONTROLS } from "../controls.jsx";
import { SettingRow } from "./SettingRow.jsx";
import { SHARE_TARGETS } from "../../lib/profileOptions.js";
import { isShared, withSharing } from "../../lib/profileText.js";

const Segmented = CONTROLS.segmented;
const Toggle = CONTROLS.toggle;
const Slider = CONTROLS.slider;

const KINDS = [
  { value: "claude", label: "Claude" },
  { value: "codex-cli", label: "Codex" },
  { value: "gemini-cli", label: "Gemini" },
];

// "Preview as agent": the exact block a new agent of the chosen provider gets —
// rendered by the daemon with the same code as a real spawn — plus who receives it
// and how much of the prompt it may take.
export function AgentPreview({ profile, onSave }) {
  const [kind, setKind] = useState("claude");
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getProfilePreview({ kind })
      .then((p) => { if (alive) setPreview(p); })
      .catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; };
  }, [kind, profile.rev]);

  return (
    <>
      <div className="stg-group">
        <div className="stg-group__title prof-group-title">
          <span>What agents see</span>
          <Segmented value={kind} onChange={setKind} options={KINDS} />
        </div>
        <div className="stg-row stg-row--stack">
          {preview?.withheld && <div className="prof-preview__note">Not shared with this provider — it gets the stock preferences.</div>}
          <pre className="prof-preview">{preview?.text ?? "…"}</pre>
          <div className="prof-instr-foot">
            <span>Applies to new agents. Running ones keep the prompt they started with.</span>
            {preview && <span className="mono">{preview.tokens} / {preview.budgetTokens} tokens</span>}
          </div>
        </div>
      </div>

      <div className="stg-group">
        <div className="stg-group__title">Shared with</div>
        {SHARE_TARGETS.map((t) => (
          <SettingRow key={t.id} label={t.label}>
            <Toggle
              value={isShared(profile, t)}
              onChange={(on) => onSave({ sharing: { withholdFrom: withSharing(profile, t.id, on) } })}
            />
          </SettingRow>
        ))}
        <SettingRow label="Prompt budget" desc="Memories past it are left for agents to look up">
          <Slider
            value={profile.budgetTokens}
            onChange={(v) => onSave({ budgetTokens: v })}
            min={200}
            max={4000}
            step={100}
            format={(v) => `${v} tok`}
          />
        </SettingRow>
      </div>
    </>
  );
}
