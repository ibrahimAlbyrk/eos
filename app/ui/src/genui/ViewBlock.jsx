// ViewBlock — a present / present_app call in the transcript, rendered as the
// content it is: no tool chrome, never folded. Its states:
//   streaming   the claude SDK lane streams the input (streamStore): settled
//               elements render as their tags close; a skeleton until the title
//   complete    the finished call → the whole view (state, actions live once
//               the result names the view id)
//   failed      the daemon refused it → one line; the agent fixes it below
//   render error nothing this build can render → the summary + "Show spec"
//   superseded  a later view replaced it → a stub that can still be opened
// ViewSurface is the view itself, shared with the side-panel tab.

import "./view.css";
import { Component as ReactComponent, memo, useEffect, useMemo, useRef, useState } from "react";
import { parseMarkup, parsePartial } from "../../../../contracts/src/genui/markup.ts";
import { useUi } from "../state/ui.jsx";
import { viewTabId } from "../lib/panelTabs.js";
import { useStream } from "./streamStore.js";
import { genuiKindOf, isFinalInput, offKindOf, partialInput, problemLines, viewIdFromResult } from "./runtime/toolCall.js";
import { ViewProvider } from "./runtime/ViewContext.jsx";
import { toneVars } from "./runtime/runtime.js";
import { GvIcon, hasIcon } from "./runtime/icons.jsx";
import { useActionHost, useGenuiConversation } from "./runtime/host.jsx";
import { adoptLocalState, isPersistentViewId } from "./runtime/viewStateStore.js";
import { ensureGenuiSettings } from "./runtime/genuiSettings.js";
import { seedViewRecord } from "./panel/viewRecords.js";
import { hasUnknownTags, renderNodes } from "./render.jsx";
import { KIT } from "./kit/index.js";
import { AppFrame } from "./apps/AppFrame.jsx";

const EXPAND_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" x2="14" y1="3" y2="10" /><line x1="3" x2="10" y1="21" y2="14" />
  </svg>
);
const WARN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4M12 17h.01" />
  </svg>
);
const X_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" />
  </svg>
);

// The header's meta line: the main collection's size and the time it was shown
// ("6 PLACES · 19:30"). Only plural-named collections count — "merge" or
// "budget" read badly as a count.
export function viewMeta(spec, ts) {
  const parts = [];
  let best = null;
  for (const [name, v] of Object.entries(spec?.data ?? {})) {
    if (name === "sources" || !Array.isArray(v) || !/s$/i.test(name)) continue;
    if (!best || v.length > best.n) best = { name, n: v.length };
  }
  if (best && best.n > 0) parts.push(`${best.n} ${best.name}`);
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }
  return parts.join(" · ");
}

// The spec to render: the finished input once it exists (kept by identity for
// the call, so a re-parsed transcript doesn't rebuild the view), else the
// stream parsed so far.
function useSpec(tool, final, stream) {
  const ref = useRef({ id: null, final: false, text: null, spec: {} });
  const cur = ref.current;
  if (final) {
    if (cur.id !== tool.id || !cur.final) ref.current = { id: tool.id, final: true, text: null, spec: tool.input };
    return ref.current.spec;
  }
  const text = stream?.text ?? "";
  if (cur.id !== tool.id || cur.final || cur.text !== text) {
    ref.current = { id: tool.id, final: false, text, spec: text ? partialInput(text) : (tool.input ?? {}) };
  }
  return ref.current.spec;
}

export const ViewBlock = memo(function ViewBlock({ block }) {
  const tool = block.tool;
  const conv = useGenuiConversation();
  const kind = genuiKindOf(tool.name) ?? "view";
  const stream = useStream(conv?.workerId ?? null, tool.id);
  const final = isFinalInput(tool.input, kind);
  const spec = useSpec(tool, final, stream);
  const result = tool.result;
  const viewId = viewIdFromResult(result);
  const localKey = `local:${tool.id}`;
  const [openOld, setOpenOld] = useState(false);

  useEffect(() => { ensureGenuiSettings(); }, []);
  useEffect(() => { if (viewId) adoptLocalState(localKey, viewId); }, [viewId, localKey]);

  const off = offKindOf(result);
  if (off) {
    return (
      <div className="gv-failed gv-failed--off">
        {X_ICON}<span>{off === "apps" ? "Apps are off — answered without one" : "Visual answers are off — answered in text"}</span>
      </div>
    );
  }
  // A finished call that names no view stored nothing (a refusal sent back as a
  // plain result): never render or run its input.
  if (result?.isError || (result && !viewId)) {
    return <FailedLine title={spec.title} result={result} fixedBelow={conv?.fixedBelow?.has(tool.id) ?? false} />;
  }
  // Ended with no result: the turn was interrupted before the view existed.
  if (!result && !tool.running && !block.live) {
    return <FailedLine title={spec.title} result={null} fixedBelow={conv?.fixedBelow?.has(tool.id) ?? false} interrupted />;
  }
  const superseded = viewId ? conv?.superseded?.get(viewId) : null;
  if (superseded && !openOld) {
    return <SupersededStub viewId={viewId} spec={spec} onShow={() => setOpenOld(true)} />;
  }
  if (kind === "app") {
    // Agent code runs only once the daemon has stored the app: before the result
    // the call may yet be refused (apps off, invalid, not this agent's tool).
    return (
      <AppBlock
        viewId={viewId}
        spec={spec}
        pending={!final || !isPersistentViewId(viewId)}
        workerId={conv?.workerId ?? null}
        project={conv?.project ?? null}
        send={conv?.send}
        createdAt={tool.ts}
      />
    );
  }
  if (!spec.title) return <ViewSkeleton tone={spec.tone} />;
  return (
    <ViewSurface
      viewId={viewId ?? localKey}
      spec={spec}
      streaming={!final}
      ts={tool.ts}
      workerId={conv?.workerId ?? null}
    />
  );
});

function AppBlock({ viewId, spec, pending, workerId, project, send, createdAt }) {
  const ui = useUi();
  const onSend = (text) => {
    if (!send || !text) return Promise.resolve({ ok: false });
    const action = isPersistentViewId(viewId)
      ? { viewId, actionId: "app", label: String(text).slice(0, 200), viewTitle: String(spec.title ?? "").slice(0, 200) }
      : undefined;
    return send(String(text), { queueWhenBusy: true, ...(action ? { action } : {}) });
  };
  const persistent = isPersistentViewId(viewId);
  const onOpenPanel = persistent
    ? () => {
      seedViewRecord({ id: viewId, workerId, title: spec.title, createdAt, kind: "app", spec });
      ui.openPanel(viewTabId(viewId));
    }
    : undefined;
  return (
    <div data-genui-view={persistent ? viewId : undefined}>
      <AppFrame
        viewId={persistent ? viewId : null}
        title={spec.title}
        html={pending ? "" : spec.html}
        height={spec.height}
        summary={spec.summary}
        onSend={onSend}
        onOpenPanel={onOpenPanel}
        project={project}
        pending={pending}
      />
    </div>
  );
}

// The view itself: the well, its header and the rendered markup. variant
// "panel" is the side-panel copy (no expand button, fills the tab).
export function ViewSurface({ viewId, spec, streaming = false, ts, workerId = null, variant = "inline" }) {
  const ui = useUi();
  const host = useActionHost();
  const parsed = useMemo(
    () => (streaming ? parsePartial(spec.ui ?? "") : parseMarkup(spec.ui ?? "")),
    [spec.ui, streaming],
  );
  const nodes = parsed.nodes;
  const renderable = nodes.some((n) => n.type === "element" && KIT[n.name]);
  const partial = useMemo(() => !streaming && hasUnknownTags(nodes), [nodes, streaming]);
  const style = useMemo(() => toneVars(spec.tone), [spec.tone]);
  const canExpand = variant === "inline" && isPersistentViewId(viewId);

  if (!streaming && !renderable) return <ViewFallback spec={spec} />;

  const expand = () => {
    seedViewRecord({ id: viewId, workerId, title: spec.title, createdAt: ts ?? Date.now(), kind: "view", spec });
    ui.openPanel(viewTabId(viewId));
  };

  return (
    <SurfaceBoundary spec={spec}>
      <section
        className={"gv-view" + (variant === "panel" ? " gv-view--panel" : "")}
        style={style}
        data-genui-view={variant === "inline" && isPersistentViewId(viewId) ? viewId : undefined}
        aria-label={spec.title}
        aria-busy={streaming || undefined}
      >
        <header className="gv-head">
          <span className="gv-head-icon"><GvIcon name={hasIcon(spec.icon) ? spec.icon : "sparkles"} size={17} /></span>
          <div className="gv-head-text">
            <div className="gv-title">{spec.title}</div>
            <div className="gv-meta">{viewMeta(spec, ts)}</div>
          </div>
          {canExpand && (
            <button type="button" className="gv-chrome-btn" onClick={expand} title="Open in side panel" aria-label="Open in side panel">
              {EXPAND_ICON}
            </button>
          )}
        </header>
        <ViewProvider viewId={viewId} viewTitle={spec.title} spec={spec} nodes={nodes} streaming={streaming} host={host}>
          <div className="gv-body">
            {renderNodes(nodes)}
            {streaming && <StreamingTail empty={!nodes.length} />}
            {partial && <PartialNote summary={spec.summary} />}
          </div>
        </ViewProvider>
      </section>
    </SurfaceBoundary>
  );
}

// Some element isn't in this build's kit: the rest renders, and the summary is
// a click away so nothing the agent said is lost.
function PartialNote({ summary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gv-partial">
      <div className="gv-partial-line">
        {WARN_ICON}<span>Part of this view needs a newer Eos</span>
        {summary ? <button type="button" className="gv-link" onClick={() => setOpen((v) => !v)}>{open ? "Hide summary" : "Show summary"}</button> : null}
      </div>
      {open && summary ? <div className="gv-partial-summary">{summary}</div> : null}
    </div>
  );
}

function StreamingTail({ empty }) {
  if (!empty) return <span className="gv-shim gv-skel-line" style={{ width: "40%", margin: "2px 6px" }} aria-hidden="true" />;
  return (
    <div className="gv-skel" aria-hidden="true">
      <span className="gv-shim gv-skel-block" />
      <div className="gv-skel-row"><span className="gv-shim" /><span className="gv-shim" /><span className="gv-shim" /></div>
    </div>
  );
}

// Before the title arrives (or a lane that doesn't stream, while the call runs).
export function ViewSkeleton({ title, tone, note = "Composing a view…" }) {
  return (
    <section className="gv-view" style={toneVars(tone)} aria-busy="true" aria-label={title || "Composing a view"}>
      <div className="gv-skel">
        <div className="gv-skel-head">
          <span className="gv-shim" />
          <span className="gv-skel-lines">
            {title
              ? <span className="gv-title">{title}</span>
              : <span className="gv-shim gv-skel-line" style={{ width: "55%" }} />}
            <span className="gv-shim gv-skel-line" style={{ width: "35%", height: 8 }} />
          </span>
        </div>
        <span className="gv-shim gv-skel-block" />
        <div className="gv-skel-row"><span className="gv-shim" /><span className="gv-shim" /><span className="gv-shim" /></div>
        <span className="gv-skel-note">{note}</span>
      </div>
    </section>
  );
}

function FailedLine({ title, result, fixedBelow, interrupted = false }) {
  const [open, setOpen] = useState(false);
  const problems = problemLines(result);
  const what = interrupted ? "stopped before it was shown" : fixedBelow ? "fixed below" : problems[0] ?? "the daemon refused it";
  return (
    <div>
      <div className="gv-failed">
        {X_ICON}
        <span className="gv-failed-title">Couldn't render{title ? ` “${title}”` : " a view"} — {what}</span>
        {!interrupted && result?.text && (
          <button type="button" className="gv-link" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Details"}</button>
        )}
      </div>
      {open && <pre className="gv-problems">{result.text}</pre>}
    </div>
  );
}

function SupersededStub({ viewId, spec, onShow }) {
  const meta = viewMeta(spec, null);
  return (
    <div className="gv-stub" style={toneVars(spec.tone)} data-genui-view={viewId}>
      <span className="gv-stub-icon"><GvIcon name={hasIcon(spec.icon) ? spec.icon : "sparkles"} size={13} /></span>
      <span className="gv-stub-text">
        <span className="gv-stub-title">{spec.title}{meta ? ` · ${meta.toLowerCase()}` : ""}</span>
        <span className="gv-stub-sub">earlier version · updated below</span>
      </span>
      <button type="button" className="gv-link" onClick={onShow}>Show</button>
    </div>
  );
}

// Nothing renderable (an old build, an unknown component, a crash): the
// required summary stands in. Nothing blank, nothing raw.
export function ViewFallback({ spec }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gv-fallback">
      <div className="gv-fallback-head">{WARN_ICON}This view couldn't be displayed · showing its summary</div>
      <div className="gv-fallback-summary">{spec.summary || spec.title || ""}</div>
      <button type="button" className="gv-link" onClick={() => setOpen((v) => !v)}>{open ? "Hide spec" : "Show spec"}</button>
      {open && <pre className="gv-problems">{specText(spec)}</pre>}
    </div>
  );
}

function specText(spec) {
  try {
    return JSON.stringify(spec, null, 2);
  } catch {
    return String(spec?.ui ?? "");
  }
}

class SurfaceBoundary extends ReactComponent {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn("[genui] view failed to render:", error);
  }

  render() {
    if (this.state.failed) return <ViewFallback spec={this.props.spec} />;
    return this.props.children;
  }
}
