import { useState } from "react";

// The small editors a slot's underlined value opens: a menu, a line of text,
// a glob, an agent's brief and model; and Eos's own dialog that adds a
// recipient. Each calls `done(value)` with the part's new value, or `done()`
// to close without one.

function Buttons({ save, done, saveLabel = "Save" }) {
  return (
    <div className="eos-actions">
      <button type="button" className="eos-btn eos-btn--primary" onClick={save}>{saveLabel}</button>
      <button type="button" className="eos-btn" onClick={() => done()}>Cancel</button>
    </div>
  );
}

export function MenuEditor({ part, done }) {
  return (
    <ul className="eos-menu eos-bp-editor" role="menu" aria-label={part.label}>
      {part.options.map((o) => (
        <li key={String(o.value)} role="none">
          <button type="button" role="menuitemradio" aria-checked={o.value === part.value} className="eos-menu__item" onClick={() => done(o.value)}>
            {o.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

// A line of text, or a glob; `part.check` answers true or what is wrong.
export function TextEditor({ part, done }) {
  const [value, setValue] = useState(part.value ?? "");
  const [wrong, setWrong] = useState(null);
  const glob = part.editor === "glob";
  const save = () => {
    const v = value.trim();
    const verdict = part.check && v ? part.check(v) : true;
    if (verdict !== true) return setWrong(verdict);
    done(v);
  };
  return (
    <div className="eos-bp-editor" role="group" aria-label={part.label}>
      <input
        type="text"
        className={glob ? "eos-bp-input eos-bp-input--glob" : "eos-bp-input"}
        aria-label={part.label}
        placeholder={glob ? "A glob such as src/**/*.rs" : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") done();
        }}
      />
      {wrong && <p className="eos-bp-wrong" role="alert">{wrong}</p>}
      <Buttons save={save} done={done} />
    </div>
  );
}

export function AgentEditor({ part, done }) {
  const [brief, setBrief] = useState(part.value.brief);
  const [model, setModel] = useState(part.value.model);
  return (
    <div className="eos-bp-editor" role="group" aria-label={part.label}>
      <label className="eos-label" htmlFor="eos-bp-brief">Brief</label>
      <textarea id="eos-bp-brief" className="eos-bp-input" rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} />
      <label className="eos-label" htmlFor="eos-bp-model">Model</label>
      <select id="eos-bp-model" className="eos-bp-input" value={model} onChange={(e) => setModel(e.target.value)}>
        {part.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Buttons save={() => done({ brief, model })} done={done} />
    </div>
  );
}

// Eos's own dialog, outside anything an agent wrote: only the user adds a
// recipient.
export function RecipientDialog({ part, done }) {
  const [address, setAddress] = useState(part.value.address);
  const add = () => {
    if (address.trim()) done({ channel: part.value.channel, address: address.trim() });
  };
  return (
    <div className="eos-sheet-overlay" onMouseDown={() => done()}>
      <div className="eos-sheet" role="dialog" aria-modal="true" aria-labelledby="eos-bp-recipient-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="eos-bp-recipient-title" className="eos-sheet__title">Add a recipient</h2>
        <p className="eos-note">Results this routine sends go to this address too.</p>
        <input type="email" className="eos-bp-input" aria-label="Mail address" value={address} onChange={(e) => setAddress(e.target.value)} />
        <Buttons save={add} done={done} saveLabel="Add" />
      </div>
    </div>
  );
}

const EDITORS = { menu: MenuEditor, text: TextEditor, glob: TextEditor, agent: AgentEditor, recipient: RecipientDialog };

export function PartEditor({ part, done }) {
  const Editor = EDITORS[part.editor];
  return Editor ? <Editor part={part} done={done} /> : null;
}
