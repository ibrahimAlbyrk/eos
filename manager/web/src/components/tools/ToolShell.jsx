import { memo, useState } from "react";
import { Icon, CopyBtn, FileOpenButton } from "../primitives.jsx";

// Common chrome for every tool block. Each tool family supplies:
//   family   — class suffix that drives accent color (.vb-tool--<family>)
//   icon     — name from icons.jsx
//   title    — pre-styled head content (a node, not a string)
//   subtitle — secondary line (mono, dimmed)
//   status   — { tone: "ok"|"err"|"run"|"info", label }
//   filePath — optional, renders the file-open affordance
//   actions  — optional extra head buttons
//   body     — the rendered body (null collapses the chevron)
//   defaultOpen — whether collapsed-by-default is overridden
//   copyText — when set, head shows a copy affordance for the source payload
const TONE_PILL = {
  ok:  { className: "vb-pill vb-pill--ok",  icon: "check",   label: "ok" },
  err: { className: "vb-pill vb-pill--err", icon: "cross",   label: "err" },
  run: { className: "vb-pill vb-pill--warn", icon: "spin",   label: "running" },
  info:{ className: "vb-pill vb-pill--info", icon: null,     label: "" },
};

export const StatusPill = memo(function StatusPill({ tone = "info", label }) {
  const conf = TONE_PILL[tone] || TONE_PILL.info;
  return (
    <span className={conf.className}>
      {conf.icon === "spin" ? <span className="vb-spinner" />
        : conf.icon ? <Icon name={conf.icon} size={10} /> : null}
      {label || conf.label}
    </span>
  );
});

export const ToolShell = memo(function ToolShell({
  family,
  icon,
  title,
  subtitle,
  status,
  filePath,
  actions,
  body,
  defaultOpen = false,
  copyText,
  bare = false,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = body != null;
  const expandable = hasBody && !bare;

  const onHeadClick = expandable ? () => setOpen(o => !o) : undefined;
  const HeadTag = expandable ? "button" : "div";

  return (
    <div className={`vb-tool vb-tool--${family} ${open ? "is-open" : ""} ${bare ? "is-bare" : ""}`}>
      <HeadTag
        className={`vb-tool__head ${expandable ? "" : "vb-tool__head--static"}`}
        onClick={onHeadClick}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="vb-tool__icon"><Icon name={icon} size={14} /></span>
        <div className="vb-tool__head-text">
          <div className="vb-tool__head-name">
            {title}
            {expandable && <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />}
          </div>
          {subtitle && <div className="vb-tool__head-args">{subtitle}</div>}
        </div>
        <span className="vb-tool__actions">
          {actions}
          {copyText != null && <CopyBtn text={copyText} />}
          {filePath && <FileOpenButton path={filePath} />}
          {status && <StatusPill tone={status.tone} label={status.label} />}
        </span>
      </HeadTag>
      {hasBody && (open || bare) && (
        <div className="vb-tool__body vb-tool__body--solo">
          {body}
        </div>
      )}
    </div>
  );
});

// Helper: render a key/value chip row (used by Grep, Web, Orchestrator
// headers). Each chip is `label: value` with the label dim and the value
// in the family accent color.
export const Chips = memo(function Chips({ items }) {
  const filtered = items.filter(x => x && x.value != null && x.value !== "");
  if (!filtered.length) return null;
  return (
    <div className="vb-tool__chips">
      {filtered.map((c, i) => (
        <span key={i} className={`vb-tool__chip vb-tool__chip--${c.tone || "neutral"}`}>
          {c.label && <span className="vb-tool__chip-k">{c.label}</span>}
          <span className="vb-tool__chip-v">{c.value}</span>
        </span>
      ))}
    </div>
  );
});

// Helper: monospace block with a label header and copy button. Used by
// any tool that wants to expose the raw payload alongside its rendered view.
export const RawPane = memo(function RawPane({ label, text }) {
  if (!text || !String(text).trim()) return null;
  return (
    <div className="vb-tool__pane">
      <div className="vb-tool__pane-head">
        <span>{label}</span>
        <div className="vb-tool__pane-actions"><CopyBtn text={text} /></div>
      </div>
      <pre className="vb-code">{text}</pre>
    </div>
  );
});

// Helper: an inline path renderer that splits a long file path into
// `dir/.../<basename>` so the basename stays readable but the directory
// truncates gracefully when the column gets narrow.
export const PathLine = memo(function PathLine({ path, accent = false }) {
  if (!path) return null;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <span className={`vb-pathline ${accent ? "is-accent" : ""}`}>
      {dir && <span className="vb-pathline__dir">{dir}/</span>}
      <span className="vb-pathline__file">{file}</span>
    </span>
  );
});
