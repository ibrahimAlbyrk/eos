// A Workflow call in the transcript: the run's live card (design A). Its phases
// as a rail, each phase's agents with what they are doing, and once it ends the
// script's log. "Open live view" opens the run's side-panel tab (design B).

import { useEffect, useMemo } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useClockTick } from "../../../hooks/useClockTick.js";
import { fetchWorkflowRun, noteWorkflowCall, useWorkflowRun } from "../../../state/workflowRunsStore.js";
import { isRunActive, runStatusOf, workflowRunModel } from "../../../lib/workflowRuns.js";
import { workflowTabId } from "../../../lib/panelTabs.js";
import { ToolItem } from "../messages/ToolItem.jsx";
import { AgentGlyph, StatusChip, StopButton, WorkflowIcon, fmtTime, totalsLine } from "./parts.jsx";
import { fmtTokens } from "../../../lib/format.js";

// A call the daemon never reported on (made before live runs existed) shows as
// the plain tool row once it's clearly not just about to start.
const UNKNOWN_AFTER_MS = 15_000;

const CALL_VERB = { starting: "Starting workflow", running: "Running workflow", completed: "Ran workflow", failed: "Workflow failed", stopped: "Stopped workflow" };

export function WorkflowCard({ block, workerId, cwd, workers }) {
  const ui = useUi();
  const tool = block.tool;
  const entry = useWorkflowRun(workerId, tool.id);
  const status = runStatusOf(block, entry);
  const known = Boolean(block.started || block.completed || entry?.live || entry?.detail);
  const unknown = !known && entry?.fetched === true && Date.now() - (tool.ts ?? 0) > UNKNOWN_AFTER_MS;
  const now = useClockTick(isRunActive(status) && !unknown);
  const model = useMemo(() => workflowRunModel(block, entry, now), [block, entry, now]);

  useEffect(() => { if (workerId) noteWorkflowCall(workerId, tool.id, tool); }, [workerId, tool]);
  // Hydrate a live run (its progress so far, whether it can stop); refetch once
  // it ends, for what only its record has (the script's log, phase details).
  const ended = Boolean(block.completed);
  useEffect(() => {
    if (workerId) void fetchWorkflowRun(workerId, tool.id, { force: ended });
  }, [workerId, tool.id, ended]);

  if (tool.result?.isError || unknown) {
    return <ToolItem tool={tool} standalone cwd={cwd} workers={workers} />;
  }

  const openLive = (agentKey) => ui.openPanel(workflowTabId(workerId, tool.id), agentKey ? { agentKey } : undefined);

  return (
    <div className="wr">
      <div className="wr-call">
        <WorkflowIcon />
        <span className={"wr-call__verb" + (model.active ? " ti-shimmer" : "")}>{CALL_VERB[model.status]}</span>
        <span className="wr-call__name">{model.name}</span>
      </div>
      <section className="wr-card" aria-label={`Workflow ${model.name}`}>
        <header className="wr-head">
          <div className="wr-head__main">
            <StatusChip status={model.status} />
            {model.description && <p className="wr-desc">{model.description}</p>}
          </div>
          {model.elapsedMs != null && <span className="wr-elapsed">{fmtTime(model.elapsedMs)}</span>}
          {model.canStop && <StopButton workerId={workerId} callId={tool.id} />}
        </header>
        {model.phases.length > 0 && <PhaseRail phases={model.phases} />}
        {model.phases.some((p) => p.agents.length) && (
          <div className="wr-groups">
            {model.phases.filter((p) => p.agents.length).map((p) => (
              <PhaseGroup key={p.index} phase={p} groupKey={`wr:${tool.id}:${p.index}`} onOpen={openLive} />
            ))}
          </div>
        )}
        {!model.active && model.logs.length > 0 && <RunLog logs={model.logs} />}
        <footer className="wr-foot">
          <span className="wr-foot__totals">{totalsLine(model.totals)}</span>
          <button type="button" className="wr-btn wr-btn--ghost" onClick={() => openLive()}>
            Open live view
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5H9.5V7.5M9.5 2.5 3 9" /></svg>
          </button>
        </footer>
      </section>
    </div>
  );
}

const PHASE_META = {
  pending: () => "not started",
  running: (p) => `${p.counts.done + p.counts.failed} of ${p.counts.total}`,
  done: (p) => `${p.counts.total} agent${p.counts.total === 1 ? "" : "s"}`,
  error: (p) => `${p.counts.failed} failed`,
  stopped: (p) => `${p.counts.stopped} stopped`,
};

function PhaseRail({ phases }) {
  return (
    <ol className="wr-rail">
      {phases.map((p) => (
        <li key={p.index} className={`wr-rail__phase is-${p.state}`}>
          <div className="wr-rail__top">
            <span className="wr-rail__n">{String(p.index).padStart(2, "0")}</span>
            <span className="wr-rail__title">{p.title}</span>
            <PhaseMark state={p.state} />
          </div>
          <div className="wr-bar"><span className="wr-bar__fill" style={{ width: `${Math.round((p.state === "done" ? 1 : p.progress) * 100)}%` }} /></div>
          <span className="wr-rail__meta">{PHASE_META[p.state](p)}</span>
        </li>
      ))}
    </ol>
  );
}

function PhaseMark({ state }) {
  if (state === "running") return <span className="wr-dot" role="img" aria-label="Running" />;
  if (state === "done") {
    return <svg className="wr-check" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done"><path d="M3 7.4 5.8 10 11 4.3" /></svg>;
  }
  if (state === "error") return <span className="wr-x" role="img" aria-label="Failed">!</span>;
  if (state === "stopped") {
    return <svg className="wr-stopmark" width="9" height="9" viewBox="0 0 10 10" role="img" aria-label="Stopped"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
  }
  return null;
}

// A phase's agents. Running or failed phases open by default, finished ones
// fold; a toggle is remembered like a tool group's.
function PhaseGroup({ phase, groupKey, onOpen }) {
  const ui = useUi();
  const byDefault = phase.state === "running" || phase.state === "error";
  const open = byDefault !== ui.expandedTools.has(groupKey);
  return (
    <div className="wr-group">
      <button type="button" className="wr-group__head" aria-expanded={open} onClick={() => ui.toggleToolExpanded(groupKey)}>
        <svg className={"wr-chev" + (open ? " is-open" : "")} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        <span className="wr-group__title">{phase.title}</span>
        {phase.detail && <span className="wr-group__detail">{phase.detail}</span>}
        <span className="wr-group__count">{phase.counts.total} agent{phase.counts.total === 1 ? "" : "s"}{phase.counts.running ? ` · ${phase.counts.running} live` : ""}</span>
      </button>
      {open && (
        <div className="wr-rows">
          {phase.agents.map((a) => <AgentRow key={a.key} agent={a} onOpen={() => onOpen(a.key)} />)}
        </div>
      )}
    </div>
  );
}

export function AgentRow({ agent, onOpen }) {
  const tone = agent.state === "running" ? " ti-shimmer" : agent.state === "error" ? " is-error" : agent.state === "queued" || agent.state === "cancelled" ? " is-queued" : "";
  return (
    <button type="button" className="wr-row" onClick={onOpen} title={`Open ${agent.label}`}>
      <AgentGlyph agent={agent} />
      <span className={"wr-row__label" + (agent.state === "queued" ? " is-queued" : "")}>{agent.label}</span>
      <span className={"wr-row__activity" + tone}>{agent.activity}</span>
      <span className="wr-row__num">{agent.tokens ? fmtTokens(agent.tokens) : ""}</span>
      <span className="wr-row__num">{agent.state === "queued" ? "queued" : fmtTime(agent.elapsedMs)}</span>
    </button>
  );
}

export function RunLog({ logs }) {
  return (
    <div className="wr-log">
      <span className="wr-label">Log</span>
      <ol className="wr-log__lines">
        {logs.map((l, i) => <li key={i}>{l}</li>)}
      </ol>
    </div>
  );
}
