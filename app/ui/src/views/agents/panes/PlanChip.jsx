import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { RollingLabel } from "../../../components/RollingLabel.jsx";
import { parseWorkerTasks } from "../../../lib/workerTasks.js";

// Plan chip — the agent's TodoWrite list as a progress ring + "done/total"
// beside the breadcrumb, so the plan costs no vertical space. Hover peeks the
// in-flight task; click opens the plan popover. Both portal to <body>: the
// crumb clips (overflow:hidden) and split panes paint-contain (HeaderAgentMenu
// idiom). data-popover stays on the portal root so the global outside-click
// handler treats clicks inside as inside.
//
// Data is the worker's `tasks` column — a JSON snapshot of Claude's TodoWrite
// list, daemon-stamped on every TodoWrite call and nulled on /clear (see
// core/src/domain/tasks.ts). It rides the /workers refetch, so it updates live.
// Hidden until the agent actually has a task list.

const RING_C = 2 * Math.PI * 6;

export function PlanChip({ worker }) {
  const ui = useUi();
  const ref = useRef(null);
  const [hover, setHover] = useState(false);

  const tasks = parseWorkerTasks(worker);
  if (tasks.length === 0) return null;

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.find((t) => t.status === "in_progress");
  const open = ui.openPopover === "plan";

  const peek = active
    ? (active.activeForm || active.content)
    : done === total ? "All tasks done" : `${done} of ${total} done`;

  const toggle = (e) => {
    e.stopPropagation();
    setHover(false);
    if (open) ui.closeAllPops();
    else ui.openPop("plan");
  };

  const rect = open || hover ? ref.current?.getBoundingClientRect() : null;
  const pos = rect && {
    top: Math.round(rect.bottom + 8),
    left: Math.round(Math.max(8, Math.min(rect.left - 6, window.innerWidth - 348))),
  };

  return (
    <>
      <button
        ref={ref}
        className={"plan-chip" + (open ? " on" : "")}
        onClick={toggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-popover-trigger="plan"
        aria-expanded={open}
        aria-label={`Plan: ${done} of ${total} done`}
      >
        <PlanRing pct={done / total} />
        <span className="plan-chip-count">
          <RollingLabel text={`${done}/${total}`} index={done} />
        </span>
      </button>
      {pos && !open && createPortal(<div className="plan-tip" style={pos}>{peek}</div>, document.body)}
      {pos && open && <PlanPopover tasks={tasks} done={done} total={total} pos={pos} />}
    </>
  );
}

function PlanPopover({ tasks, done, total, pos }) {
  const [showDone, setShowDone] = useState(false);
  const completed = tasks.filter((t) => t.status === "completed");
  const remaining = tasks.filter((t) => t.status !== "completed");

  return createPortal(
    <div className="plan-pop" data-popover="plan" style={pos}>
      <div className="plan-head">
        <span>Plan</span>
        <span className="plan-count">{done}/{total}</span>
      </div>
      <div className="plan-list">
        {done > 0 && (
          <button className="plan-row plan-summary" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone}>
            <DoneIcon />
            <span className="plan-label">{done} completed</span>
            <span className="plan-toggle">{showDone ? "Hide" : "Show"}</span>
          </button>
        )}
        {showDone && completed.map((t, i) => (
          <div key={`d${i}`} className="plan-row completed">
            <CheckIcon />
            <span className="plan-label">{t.content}</span>
          </div>
        ))}
        {remaining.map((t, i) => (
          <div key={`r${i}`} className={`plan-row ${t.status}`}>
            {t.status === "in_progress" ? <ActiveIcon /> : <PendingIcon />}
            <span className="plan-label">{t.status === "in_progress" ? (t.activeForm || t.content) : t.content}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function PlanRing({ pct }) {
  return (
    <svg className="plan-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="plan-ring-track" cx="8" cy="8" r="6" />
      {pct > 0 && (
        <circle className="plan-ring-fill" cx="8" cy="8" r="6" strokeDasharray={`${pct * RING_C} ${RING_C}`} />
      )}
    </svg>
  );
}

function DoneIcon() {
  return (
    <svg className="plan-ic plan-ic-done" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.2l2.1 2.1 3.9-4.3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="plan-ic plan-ic-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 8.2l2.3 2.3 4.5-5" />
    </svg>
  );
}

function ActiveIcon() {
  return (
    <svg className="plan-ic plan-ic-active" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <circle className="plan-core" cx="8" cy="8" r="2.4" />
    </svg>
  );
}

function PendingIcon() {
  return (
    <svg className="plan-ic plan-ic-pending" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}
