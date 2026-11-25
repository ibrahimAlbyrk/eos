import { useEffect, useState } from "react";
import { ROUTES } from "../../../../api/routes.js";
import { transport } from "../../../../state/eos/transport.js";
import { Dialog } from "../../frame.jsx";

// The small editors a slot's underlined value opens: a menu, a line of text,
// a glob, an agent's brief and model; and Eos's own dialog that adds a
// recipient. Each calls `done(value)` with the part's new value, or `done()`
// to close without one.

// The foot of an editor in a slot: the keys at the left, Cancel then Save
// at the right.
function Foot({ save, done, saveLabel = "Save", keys = "Enter to save, Esc to cancel" }) {
  return (
    <div className="eos-bp-editor__foot">
      {keys && <span className="eos-bp-editor__keys">{keys}</span>}
      <button type="button" className="eos-btn eos-btn--ghost" onClick={() => done()}>Cancel</button>
      <button type="button" className="eos-btn eos-btn--primary" onClick={save}>{saveLabel}</button>
    </div>
  );
}

// Dialog actions: Cancel first, the act last.
function Acts({ act, actLabel, done, disabled }) {
  return (
    <>
      <button type="button" className="eos-btn eos-btn--ghost" onClick={() => done()}>Cancel</button>
      {act && <button type="button" className="eos-btn eos-btn--primary" disabled={disabled} onClick={act}>{actLabel}</button>}
    </>
  );
}

export function MenuEditor({ part, done }) {
  return (
    <ul className="eos-menu eos-bp-editor eos-bp-editor--menu" role="menu" aria-label={part.label} onKeyDown={(e) => { if (e.key === "Escape") done(); }}>
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
// `size` is the class of the words it stands in for (the card's name or
// sentence), so the field keeps their size.
export function TextEditor({ part, done, size }) {
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
    <div className={size ? `eos-bp-editor eos-bp-editor--head ${size}` : "eos-bp-editor"} role="group" aria-label={part.label}>
      <input
        type="text"
        autoFocus
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
      <Foot save={save} done={done} />
    </div>
  );
}

// An agent's brief and the model it thinks with, the model as a choice of
// its few names rather than a list to open.
export function AgentEditor({ part, done }) {
  const [brief, setBrief] = useState(part.value.brief);
  const [model, setModel] = useState(part.value.model);
  const save = () => done({ brief, model });
  return (
    <div
      className="eos-bp-editor"
      role="group"
      aria-label={part.label}
      onKeyDown={(e) => {
        if (e.key === "Escape") done();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      }}
    >
      <label className="eos-label" htmlFor="eos-bp-brief">Brief</label>
      <textarea
        id="eos-bp-brief"
        className="eos-bp-input eos-bp-input--brief"
        rows={5}
        autoFocus
        placeholder={`What ${part.label} does, and how`}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <span className="eos-label" id="eos-bp-model">Model</span>
      <div className="eos-seg eos-bp-models" role="radiogroup" aria-labelledby="eos-bp-model">
        {part.options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === model} className="eos-seg__opt" onClick={() => setModel(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <Foot save={save} done={done} keys="⌘ Enter to save, Esc to cancel" />
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
    <Dialog
      id="eos-bp-recipient"
      from="Goes to"
      icon={MAIL}
      title="Add a recipient"
      line="Results this routine sends go to this address too, as you."
      onClose={() => done()}
      actions={<Acts act={add} actLabel="Add" done={done} disabled={!address.trim()} />}
    >
      <input
        type="email"
        className="eos-bp-input eos-ask__field"
        aria-label="Mail address"
        placeholder="name@example.com"
        autoFocus
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") add(); }}
      />
    </Dialog>
  );
}

const MAIL = "M2.5 4.5h11v7h-11zM2.5 4.5L8 9l5.5-4.5";
const HASH = "M6 2.5L4.5 13.5M11.5 2.5L10 13.5M3 6h10.5M2.5 10H13";

// Slack's conversations and people matching `q`, as Slack names them.
export async function slackChoices(q) {
  const read = async (item) => {
    const query = new URLSearchParams({ item, limit: "20", ...(q ? { q } : {}) });
    const r = await transport.get(`${ROUTES.capabilityCandidates}?${query}`).catch(() => null);
    return r?.ok && Array.isArray(r.body) ? r.body : [];
  };
  const [conversations, people] = await Promise.all([read("slack.conversation"), read("slack.person")]);
  const wanted = q.trim().toLowerCase();
  const fits = (item) => !wanted || item.title.toLowerCase().includes(wanted);
  return [...conversations.filter(fits), ...people];
}

// Eos's own dialog that adds a Slack channel or person, picked from what
// Slack lists: the id Slack gave goes into Goes to, the name is only shown.
export function SlackRecipientDialog({ done }) {
  const [q, setQ] = useState("");
  const [choices, setChoices] = useState(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => void slackChoices(q).then((found) => live && setChoices(found)), 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <Dialog
      id="eos-bp-slack"
      from="Goes to"
      icon={HASH}
      title="Add a Slack channel or person"
      line="Results this routine sends go there too, as you. Pick one Slack lists; a typed name is never taken."
      onClose={() => done()}
      actions={<Acts done={done} />}
    >
      <input type="search" className="eos-bp-input eos-ask__field" aria-label="Find a channel or person" placeholder="#channel or a name" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="eos-bp-slack-list">
        {choices === null && <p className="eos-note" role="status">Asking Slack…</p>}
        {choices?.length === 0 && <p className="eos-note" role="status">Slack lists nothing by that name.</p>}
        {choices?.length > 0 && (
          <ul className={choices.length > 6 ? "eos-bp-slack eos-bp-slack--more" : "eos-bp-slack"} role="listbox" aria-label="Slack channels and people">
            {choices.map((c) => (
              <li key={c.key} role="none">
                <button type="button" role="option" aria-selected="false" className="eos-bp-slack__item" onClick={() => done({ address: c.key, label: c.title })}>
                  <span className="eos-bp-slack__name">{c.title}</span>
                  <span className="eos-bp-slack__kind">{c.kind === "slack.person" ? "Person" : "Channel"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

const EDITORS = {
  menu: MenuEditor, text: TextEditor, glob: TextEditor, agent: AgentEditor, recipient: RecipientDialog, slack: SlackRecipientDialog,
};

export function PartEditor({ part, done }) {
  const Editor = EDITORS[part.editor];
  return Editor ? <Editor part={part} done={done} /> : null;
}
