import { useEffect, useRef, useState } from "react";
import { computeRects, computeDividers, MAX_PANES } from "../../lib/paneLayout.js";
import { basename } from "../../lib/path.js";
import { usePaneTransitions } from "../../hooks/usePaneTransitions.js";
import { onPtyExit } from "../../state/ptyBus.js";
import {
  KINDS, focusPane, splitPane, closePane, setSplitRatio, sessionExited, setTitle, setClaudeSession, dropPaneOn,
} from "../../state/codeWorkspaceStore.js";
import { TerminalView } from "../../components/terminal/TerminalView.jsx";
import { useDropSplit, DropPreview, Divider } from "../agents/panes/PaneGrid.jsx";
import { useUi } from "../../state/ui.jsx";
import { TermLauncher } from "./TermLauncher.jsx";
import { KindGlyph, SplitRightGlyph, SplitDownGlyph, CloseGlyph } from "./icons.jsx";

// dataTransfer type for a terminal pane dragged from the Code sidebar.
export const TERM_PANE_TYPE = "application/x-eos-term-pane";

// Claude Code reads ESC+CR (meta-enter) as "insert newline".
const SHIFT_ENTER = "\x1b\r";

// ANSI palette tuned to charcoal-aurora so shells and TUIs read as part of the app.
const PALETTE = {
  black: "#1c1c1c", red: "#c47f79", green: "#6fae86", yellow: "#c9a163",
  blue: "#6ea4e8", magenta: "#c8a2ff", cyan: "#5cb8c4", white: "#cccccc",
  brightBlack: "#6b6b6b", brightRed: "#e0958e", brightGreen: "#8cc9a2", brightYellow: "#e3bd7e",
  brightBlue: "#8ab9f0", brightMagenta: "#dcbfff", brightCyan: "#7fd0da", brightWhite: "#f5f5f5",
  selectionBackground: "rgba(110, 164, 232, 0.28)",
};

const pctStyle = (r) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

export function paneTitle(term) {
  if (!term) return "New session";
  return term.title || (term.kind === KINDS.shell ? "Terminal" : "Claude Code");
}

// The Code view's split layout: the Agents view's BSP renderer (flat %-rects keyed
// by leaf id, so a split/close never remounts a surviving terminal) with a PTY
// session per pane instead of an agent transcript. `paused`: the view is hidden,
// so terminals hold their output until it's shown again.
export function TermGrid({ live, ws, paused }) {
  const gridRef = useRef(null);
  const [resizing, setResizing] = useState(false);
  const rects = computeRects(ws.tree);
  const dividers = computeDividers(ws.tree);
  const { leaving, setNode } = usePaneTransitions(rects);
  const single = rects.length === 1;

  const renderSlot = ({ id, rect }, index) => (
    <div key={id} className="pane-slot" style={pctStyle(rect)}>
      <TermPane
        live={live}
        leafId={id}
        index={index}
        term={ws.terms[id] ?? null}
        cwd={ws.terms[id]?.cwd ?? ws.cwd}
        error={ws.errors[id]}
        focused={id === ws.focusedId}
        single={single}
        canSplit={rects.length < MAX_PANES}
        topLeft={rect.left === 0 && rect.top === 0}
        topRow={rect.top === 0}
        corner={rect.top === 0 && Math.abs(rect.left + rect.width - 100) < 0.01}
        paused={paused}
      />
    </div>
  );

  return (
    <div className={"pane-grid cw-grid" + (single ? " is-single" : "") + (resizing ? " is-resizing" : "")} ref={gridRef}>
      {rects.map(renderSlot)}
      {leaving.map(({ id, rect }) => (
        <div key={id} ref={setNode(id)} className="pane-slot is-leaving" style={pctStyle(rect)}>
          <div className="pane" />
        </div>
      ))}
      {dividers.map((d) => (
        <Divider
          key={d.id}
          d={d}
          gridRef={gridRef}
          onRatio={(r) => setSplitRatio(d.id, r)}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      ))}
    </div>
  );
}

function TermPane({ live, leafId, index, term, cwd, error, focused, single, canSplit, topLeft, topRow, corner, paused }) {
  const sessionId = term?.sessionId ?? null;
  const { zone, handlers } = useDropSplit(true, (z, srcId) => {
    if (srcId !== leafId) dropPaneOn(leafId, z, srcId);
  }, TERM_PANE_TYPE);

  // Typing `exit` in the shell closes the pane, like a terminal tab.
  useEffect(() => {
    if (!sessionId) return undefined;
    return onPtyExit(sessionId, () => sessionExited(sessionId));
  }, [sessionId]);

  const cls = ["pane", focused && !single ? "is-focused" : "", corner ? "cw-corner" : ""].filter(Boolean).join(" ");
  const headCls = ["pane-head", "cw-head", topRow ? "pane-head--toprow" : "", topLeft ? "pane-head--topleft" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} onMouseDownCapture={() => focusPane(leafId)} {...handlers}>
      {zone && <DropPreview zone={zone} />}
      <div className="pane-col">
        <div className={headCls}>
          {topLeft && <span className="pane-head-inset" aria-hidden="true" />}
          <div className="crumb cw-crumb">
            {!single && <span className="cw-num" aria-label={`Pane ${index + 1}`}>{index + 1}</span>}
            {term && <span className="cw-kind"><KindGlyph kind={term.kind} size={14} /></span>}
            <span className="cur">{paneTitle(term)}</span>
            {cwd && <span className="scope" title={cwd}>{basename(cwd)}</span>}
          </div>
          <div className="pane-head-actions">
            <button
              className="pane-split-btn"
              title="Split right (⌘D)"
              aria-label="Split right"
              disabled={!canSplit}
              onClick={(e) => { e.stopPropagation(); splitPane(leafId, "row", term?.kind ?? KINDS.claude); }}
            >
              <SplitRightGlyph />
            </button>
            <button
              className="pane-split-btn"
              title="Split down (⇧⌘D)"
              aria-label="Split down"
              disabled={!canSplit}
              onClick={(e) => { e.stopPropagation(); splitPane(leafId, "col", term?.kind ?? KINDS.claude); }}
            >
              <SplitDownGlyph />
            </button>
            {corner && <SidePanelSlot />}
            {(term || !single) && (
              <button
                className="pane-close"
                title={single ? "End session (⌘W)" : "Close pane (⌘W)"}
                aria-label="Close pane"
                onClick={(e) => { e.stopPropagation(); closePane(leafId); }}
              >
                <CloseGlyph />
              </button>
            )}
          </div>
        </div>
        <div className="cw-body">
          {term ? (
            <TerminalView
              key={term.sessionId}
              sessionId={term.sessionId}
              active={focused}
              visible
              paused={paused}
              fontSize={13}
              surface="--bg"
              palette={PALETTE}
              shiftEnter={term.kind === KINDS.claude ? SHIFT_ENTER : undefined}
              onTitle={(t) => setTitle(leafId, t)}
              onClaudeSession={(id) => setClaudeSession(leafId, id)}
            />
          ) : (
            <TermLauncher live={live} leafId={leafId} cwd={cwd} error={error} compact={!single} />
          )}
        </div>
      </div>
    </div>
  );
}

// Holds the header spot the view's side-panel toggle (an overlay drawn by
// SidePanel) sits on while the panel is closed — only in the top-right pane.
function SidePanelSlot() {
  const ui = useUi();
  return ui.showSidePanel ? null : <span className="pane-split-btn" aria-hidden="true" />;
}
