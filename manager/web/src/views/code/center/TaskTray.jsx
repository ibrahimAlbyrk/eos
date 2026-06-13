import { useState } from "react";
import { RollingLabel } from "../../../components/RollingLabel.jsx";
import { parseWorkerTasks } from "../../../lib/workerTasks.js";

// TaskTray — docked into the composer card stack as a right-aligned row that
// sits just above the input. Collapsed: an ambient capsule (progress ring +
// active task). Expanded: it grows upward into a connected card whose tasks
// hang off a vertical timeline spine that fills as the agent advances.
//
// Data is the selected worker's `tasks` column — a JSON snapshot of Claude's
// TodoWrite list, daemon-stamped on every TodoWrite call and nulled on /clear
// (see core/src/domain/tasks.ts). It rides the same /workers refetch as the
// context ring, so it updates live with no dedicated fetch. Hidden entirely
// until the agent actually has a task list.

const RING_C = 2 * Math.PI * 7; // r=7 in an 18-viewBox, same as the ctx ring

function TrayRing({ pct, active }) {
  const done = pct >= 1;
  return (
    <svg className={"tt-ring" + (done ? " done" : "")} viewBox="0 0 18 18" aria-hidden="true">
      <circle className="tt-ring-track" cx="9" cy="9" r="7" />
      {pct > 0 && (
        <circle className="tt-ring-fill" cx="9" cy="9" r="7" strokeDasharray={`${pct * RING_C} ${RING_C}`} />
      )}
      {active && !done && <circle className="tt-ring-core" cx="9" cy="9" r="2.4" />}
    </svg>
  );
}

function Node({ status }) {
  if (status === "completed") {
    return (
      <span className="tt-node">
        <svg className="tt-ic tt-ic-done" viewBox="0 0 15 15" aria-hidden="true">
          <circle cx="7.5" cy="7.5" r="6" />
          <path className="tt-check" d="M4.4 7.7l2.3 2.3 4.1-4.6" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="tt-node">
        <svg className="tt-ic tt-ic-active" viewBox="0 0 15 15" aria-hidden="true">
          <circle className="tt-halo" cx="7.5" cy="7.5" r="7" />
          <circle cx="7.5" cy="7.5" r="6" />
          <circle className="tt-core" cx="7.5" cy="7.5" r="2.6" />
        </svg>
      </span>
    );
  }
  return (
    <span className="tt-node">
      <svg className="tt-ic tt-ic-pending" viewBox="0 0 15 15" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r="6" />
      </svg>
    </span>
  );
}

function Chevron({ up }) {
  return (
    <svg className="tt-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d={up ? "M2 6.5L5 3.5L8 6.5" : "M2 3.5L5 6.5L8 3.5"}
        fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function TaskTray({ selected }) {
  const [open, setOpen] = useState(false);

  const tasks = parseWorkerTasks(selected);
  const total = tasks.length;
  // Hidden until the agent actually keeps a task list — no empty shell.
  if (total === 0) return null;

  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.find((t) => t.status === "in_progress");
  const allDone = done === total;
  const pct = total ? done / total : 0;

  const pillText = allDone
    ? "All tasks done"
    : active
      ? (active.activeForm || active.content)
      : `${done} of ${total} done`;

  return (
    <div className="task-tray-row">
      <div className="task-tray">
        {open ? (
          <div className="tt-surface tt-card">
            <button className="tt-head" onClick={() => setOpen(false)} title="Collapse">
              <TrayRing pct={pct} active={!!active} />
              <span className="tt-title">Tasks</span>
              <span className="tt-count">{done}/{total}</span>
              <Chevron />
            </button>
            <ul className="tt-list">
              {tasks.map((t, i) => (
                <li key={i} className={`tt-item ${t.status}`} style={{ animationDelay: `${i * 28}ms` }}>
                  <Node status={t.status} />
                  <span className="tt-item-label">{t.content}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <button className="tt-surface tt-pill" onClick={() => setOpen(true)} title="Show tasks">
            <TrayRing pct={pct} active={!!active} />
            <span className="tt-pill-label">
              <RollingLabel text={pillText} index={done} />
            </span>
            <span className="tt-count">{done}/{total}</span>
            <Chevron up />
          </button>
        )}
      </div>
    </div>
  );
}
