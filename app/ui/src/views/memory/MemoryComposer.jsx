import { useState } from "react";
import { CONTROLS } from "../../settings/controls.jsx";
import { createMemory } from "../../state/userMemoryStore.js";
import { CATEGORY_OPTIONS } from "../../lib/memoryGroups.js";

const Chips = CONTROLS.chips;
const Select = CONTROLS.select;

// Write a memory directly — the user's own are kept at once. `projects` are
// { value: folder, label } choices for a project-only memory.
export function MemoryComposer({ projects, onDone }) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState("work-style");
  const [scope, setScope] = useState("global");

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await createMemory({
      text: text.trim(),
      category,
      scope: scope === "global" ? { kind: "global" } : { kind: "project", path: scope },
      tier: "always",
    });
    if (r.ok) onDone();
  };

  return (
    <form className="mem-composer" onSubmit={submit}>
      <textarea
        className="stg-textarea mem-composer__text"
        value={text}
        rows={2}
        maxLength={500}
        autoFocus
        placeholder="e.g. Prefers pnpm over npm."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
      />
      <div className="mem-composer__row">
        <Chips value={category} onChange={(v) => setCategory(v ?? category)} options={CATEGORY_OPTIONS} />
        <Select value={scope} onChange={setScope} options={[{ value: "global", label: "All projects" }, ...projects]} />
      </div>
      <div className="mem-composer__actions">
        <button type="button" className="mem-btn mem-btn--ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="mem-btn mem-btn--primary" disabled={!text.trim()}>Remember</button>
      </div>
    </form>
  );
}
