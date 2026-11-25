import { useCallback, useState } from "react";
import { useProjects } from "../../../state/projectsStore.js";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
import { HOME_RUNGS, homeModels, modelLabel, projectFolder, projectLabel, rungLabel } from "./homePills.js";

const Glyph = ({ d }) => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="eos-home-pill__glyph"><path d={d} /></svg>
);
const Chevron = () => (
  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" className="eos-pill__chev"><path d="M4 6l4 4 4-4" /></svg>
);
const SHIELD = "M8 2.5l4.5 1.7v3.6c0 2.7-1.9 4.6-4.5 5.7-2.6-1.1-4.5-3-4.5-5.7V4.2z";
const FOLDER = "M2.5 5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z";

// One pill and its menu of radio items.
function PillMenu({ name, open, setOpen, label, glyph, chevron, end, disabled, title, items, value, onPick }) {
  const close = useCallback(() => setOpen(null), [setOpen]);
  const ref = useMenuDismiss(open === name, close);
  return (
    <span ref={ref} className="eos-pill-wrap">
      <button
        type="button"
        className="eos-home-pill"
        aria-haspopup="menu"
        aria-expanded={open === name}
        disabled={disabled}
        title={title}
        onClick={() => setOpen(open === name ? null : name)}
      >
        {glyph && <Glyph d={glyph} />}{label}{chevron && <Chevron />}
      </button>
      {open === name && (
        <span className={end ? "eos-intent__menu eos-intent__menu--end" : "eos-intent__menu"} role="menu">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitemradio" aria-checked={item.value === value} className="eos-intent__menuitem" onClick={() => { onPick(item.value); close(); }}>
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// The Home input's freedom and project pills (Main.dc.html); the model pill
// stands apart at the row's end, before send.
export function HomePills({ intent, choices, setChoices }) {
  const [open, setOpen] = useState(null);
  const { projects } = useProjects();
  const set = (key) => (value) => setChoices({ ...choices, [key]: value });
  const once = intent === "once";
  const projectItems = [{ value: null, label: "Any project" }, ...projects.filter(projectFolder).map((p) => ({ value: projectFolder(p), label: p.name }))];
  return (
    <>
      <PillMenu
        name="rung" open={open} setOpen={setOpen} glyph={SHIELD}
        label={rungLabel(intent, choices.rung)}
        disabled={once}
        title={once ? "A task done once always asks before anything goes out" : undefined}
        items={HOME_RUNGS} value={choices.rung} onPick={set("rung")}
      />
      <PillMenu
        name="project" open={open} setOpen={setOpen} glyph={FOLDER}
        label={projectLabel(projects, choices.project)}
        items={projectItems} value={choices.project} onPick={set("project")}
      />
      <span className="eos-input__gap" />
      <PillMenu
        name="model" open={open} setOpen={setOpen} chevron end
        label={modelLabel(intent, choices.model)}
        items={[{ value: null, label: "Default model" }, ...homeModels()]} value={choices.model} onPick={set("model")}
      />
    </>
  );
}
