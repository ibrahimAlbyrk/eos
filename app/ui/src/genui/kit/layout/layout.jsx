// Section · Stack · Grid · Split · Tabs · Disclosure · Divider — structure only:
// the agent arranges, the kit spaces. Widths come from container queries, so a
// view reflows in a narrow split pane the same way it does in a narrow window.

import { Children, createContext, useCallback, useContext, useId, useMemo, useRef, useState } from "react";
import { Icon, hasIcon } from "../icons.jsx";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum, splitLabels } from "../../../../../../contracts/src/genui/attrs.ts";
import { BadgeChip, oneOf } from "../content/text.jsx";
import { cls, isTone, toneClass, tpl } from "../content/util.js";

const GAPS = ["sm", "md", "lg"];
const ALIGNS = ["start", "center", "end", "stretch"];

// The element children a container switches or lays out (text runs between
// elements are the renderer's GvText; they carry a node of type "text").
export function elementChildren(children) {
  return Children.toArray(children).filter((c) => c && typeof c === "object" && c.props?.node?.type !== "text");
}

function childLabel(child) {
  const p = child?.props ?? {};
  const v = p.node?.attrs?.label ?? p.attrs?.label ?? p.label;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

// ── Section ─────────────────────────────────────────────────────────────────

// Lets a Carousel inside put its count and prev/next into the section header,
// as on the boards ("OTHER OPTIONS · 5   ‹ ›").
export const SectionContext = createContext(null);

export function Section({ attrs = {}, children }) {
  const view = useView();
  const title = tpl(view, attrs.title);
  const meta = tpl(view, attrs.meta);
  const icon = hasIcon(attrs.icon) ? attrs.icon : null;
  const collapsible = attrs.collapsed !== undefined;
  const [open, setOpen] = useState(!attrBool(attrs.collapsed));
  const [extra, setExtra] = useState(null);
  const owner = useRef(null);
  const bodyId = useId();
  const ctx = useMemo(() => ({ owner, setExtra }), []);
  const count = extra?.count;
  const label = (
    <>
      {icon ? <Icon name={icon} size={13} className="gv-section-icon" /> : null}
      <span className="gv-section-title">{title}</span>
      {meta ? <span className="gv-section-meta">· {meta}</span> : count != null ? <span className="gv-section-meta">· {count}</span> : null}
    </>
  );
  const head = title || icon || extra?.controls ? (
    <div className="gv-section-head">
      {collapsible ? (
        <button type="button" className="gv-section-label is-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron-right" size={13} stroke={2} className={cls("gv-chev", open && "is-open")} />
          {label}
        </button>
      ) : title || icon ? (
        <div className="gv-section-label" role="heading" aria-level={4}>{label}</div>
      ) : <span />}
      {open && extra?.controls ? <div className="gv-section-tools">{extra.controls}</div> : null}
    </div>
  ) : null;
  // A section whose carousel came up empty (the Filters chips hid it all) folds
  // away instead of showing a title over nothing; hidden, not unmounted, so the
  // carousel keeps reporting and the section returns with its items.
  return (
    <section className="gv-section" hidden={count === 0 || undefined}>
      {head}
      {open ? (
        <div className="gv-section-body" id={bodyId}>
          <SectionContext.Provider value={ctx}>{children}</SectionContext.Provider>
        </div>
      ) : null}
    </section>
  );
}

// ── Stack · Grid · Split ────────────────────────────────────────────────────

export function Stack({ attrs = {}, children }) {
  const dir = oneOf(attrs.dir, ["col", "row"], "col");
  const gap = oneOf(attrs.gap, GAPS, dir === "row" ? "sm" : "md");
  const align = oneOf(attrs.align, ALIGNS, dir === "row" ? "center" : "stretch");
  return (
    <div className={cls("gv-stack", `gv-stack-${dir}`, `gv-gap-${gap}`, `gv-align-${align}`, attrBool(attrs.wrap, dir === "row") && "is-wrap")}>
      {children}
    </div>
  );
}

const GRID_MIN = { 1: 240, 2: 240, 3: 180, 4: 140 };

export function Grid({ attrs = {}, children }) {
  const n = elementChildren(children).length;
  const cols = Math.min(4, Math.max(1, Math.round(attrNum(attrs.cols) ?? Math.min(Math.max(n, 1), 3))));
  const min = attrNum(attrs.min) ?? GRID_MIN[cols];
  const gap = oneOf(attrs.gap, GAPS, cols >= 4 ? "sm" : "md");
  return (
    <div className={cls("gv-grid", `gv-gap-${gap}`)} style={{ "--gv-cols": cols, "--gv-min": `${Math.min(480, Math.max(120, min))}px` }}>
      {children}
    </div>
  );
}

const RATIO = { "1:1": [1, 1], "1:2": [1, 2], "2:1": [2, 1], "2:3": [2, 3], "3:2": [3, 2] };

export function Split({ attrs = {}, children }) {
  const [a, b] = RATIO[oneOf(attrs.ratio, Object.keys(RATIO), "1:1")];
  const align = oneOf(attrs.align, ALIGNS, "stretch");
  return (
    <div className="gv-split">
      <div className={cls("gv-split-grid", `gv-align-${align}`)} style={{ "--gv-split-a": `${a}fr`, "--gv-split-b": `${b}fr` }}>
        {children}
      </div>
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

// The segmented switch (glass pill), shared with Kit B's Segmented look.
export function SegmentedBar({ labels, index, onPick, ariaLabel, idBase, role = "tablist" }) {
  const refs = useRef([]);
  const onKey = (e) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = labels.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (index + delta + n) % n;
    onPick(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="gv-seg" role={role} aria-label={ariaLabel} onKeyDown={onKey}>
      {labels.map((label, i) => {
        const on = i === index;
        return (
          <button
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            id={idBase ? `${idBase}-tab-${i}` : undefined}
            aria-selected={role === "tablist" ? on : undefined}
            aria-pressed={role === "tablist" ? undefined : on}
            aria-controls={idBase && on ? `${idBase}-panel` : undefined}
            tabIndex={on ? 0 : -1}
            className={cls("gv-seg-opt", on && "is-on")}
            onClick={() => onPick(i)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({ attrs = {}, node, children }) {
  const view = useView();
  const tabs = elementChildren(children);
  const named = splitLabels(attrs.labels);
  const labels = tabs.map((c, i) => named[i] ?? (childLabel(c) || `Tab ${i + 1}`));
  const bind = typeof attrs.bind === "string" && attrs.bind ? attrs.bind : null;
  // Unbound tabs still live in view state, so the inline view and its side-panel
  // copy show the same tab.
  const key = bind ?? (node?.pos ? `_tabs_${node.pos.line}_${node.pos.col}` : null);
  const [local, setLocal] = useState(0);
  const stored = key ? view?.getState?.(key, undefined) : undefined;
  let index = local;
  if (stored !== undefined) {
    const byLabel = labels.indexOf(String(stored));
    const n = attrNum(stored);
    index = byLabel >= 0 ? byLabel : n != null ? n : local;
  }
  index = Math.min(Math.max(0, Math.round(index)), Math.max(0, tabs.length - 1));
  const pick = useCallback(
    (i) => {
      setLocal(i);
      if (key && view?.setState) view.setState(key, bind ? labels[i] : i);
    },
    [key, bind, labels, view],
  );
  const idBase = useId().replace(/:/g, "");
  if (!tabs.length) return null;
  return (
    <div className="gv-tabs">
      <SegmentedBar labels={labels} index={index} onPick={pick} idBase={idBase} ariaLabel={labels.join(" / ")} />
      <div className="gv-tabs-panel" role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${index}`}>
        {tabs[index]}
      </div>
    </div>
  );
}

// ── Disclosure · Divider ────────────────────────────────────────────────────

export function Disclosure({ attrs = {}, children }) {
  const view = useView();
  const [open, setOpen] = useState(attrBool(attrs.open));
  const bodyId = useId();
  const title = tpl(view, attrs.title);
  const meta = tpl(view, attrs.meta);
  const badge = tpl(view, attrs.badge);
  const tone = isTone(attrs.tone) ? attrs.tone : null;
  const icon = hasIcon(attrs.icon) ? attrs.icon : null;
  return (
    <div className={cls("gv-disclosure", open && "is-open", toneClass(tone))}>
      <button type="button" className="gv-disclosure-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevron-right" size={13} stroke={2} className={cls("gv-chev", open && "is-open")} />
        {icon ? <Icon name={icon} size={15} className={cls("gv-disclosure-icon", tone && "is-toned")} /> : null}
        <span className="gv-disclosure-title">{title}</span>
        {badge ? <BadgeChip text={badge} tone={tone} hashTone={!tone} /> : null}
        {meta ? <span className="gv-disclosure-meta">{meta}</span> : null}
      </button>
      {open ? <div className="gv-disclosure-body" id={bodyId}>{children}</div> : null}
    </div>
  );
}

export function Divider({ attrs = {} }) {
  const view = useView();
  const label = tpl(view, attrs.label);
  return label ? (
    <div className="gv-divider has-label" role="separator" aria-label={label}>
      <span className="gv-divider-line" />
      <span className="gv-divider-text">{label}</span>
      <span className="gv-divider-line" />
    </div>
  ) : (
    <div className="gv-divider" role="separator" />
  );
}

export function useSection() {
  return useContext(SectionContext);
}
