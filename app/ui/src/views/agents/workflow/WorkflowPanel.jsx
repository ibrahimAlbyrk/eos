// A Workflow run's side-panel tab, `workflow:<workerId>/<callId>` (design B):
// phases as columns of agents, and a drawer for the selected agent — its task,
// what it came to, and its own transcript. Rebuilds from the tab id alone, so
// it survives a reload.

import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { useUi } from "../../../state/ui.jsx";
import { useClockTick } from "../../../hooks/useClockTick.js";
import { fetchWorkflowRun, useWorkflowRun } from "../../../state/workflowRunsStore.js";
import { isRunActive, runStatusOf, workflowRunModel } from "../../../lib/workflowRuns.js";
import { workflowRefOf } from "../../../lib/panelTabs.js";
import { buildBlocks } from "../../../lib/messageParser.js";
import { fmtTokens } from "../../../lib/format.js";
import { ToolBlock } from "../messages/ToolBlock.jsx";
import { MessageAssistant } from "../messages/MessageAssistant.jsx";
import { usePathLinks } from "../messages/paths/usePathLinks.jsx";
import { AgentGlyph, StatusChip, StopButton, WorkflowIcon, fmtTime, totalsLine } from "./parts.jsx";
import { RunLog } from "./WorkflowCard.jsx";

// The stream carries progress only for conversations on screen; a run whose end
// this window missed is caught by asking again now and then.
const RECHECK_MS = 10_000;

export function WorkflowPanel({ live, tabId }) {
  const ui = useUi();
  const ref = workflowRefOf(tabId);
  const workerId = ref?.workerId ?? null;
  const callId = ref?.callId ?? null;
  const entry = useWorkflowRun(workerId, callId);
  const block = useMemo(() => ({ tool: entry?.tool ?? { id: callId, input: {} }, started: null, completed: null }), [entry?.tool, callId]);
  const active = isRunActive(runStatusOf(block, entry));
  const now = useClockTick(active);
  const model = useMemo(() => workflowRunModel(block, entry, now), [block, entry, now]);

  useEffect(() => {
    if (workerId && callId) void fetchWorkflowRun(workerId, callId, { force: true });
  }, [workerId, callId]);
  useEffect(() => {
    if (!active || !workerId || !callId) return;
    const t = setInterval(() => void fetchWorkflowRun(workerId, callId, { force: true }), RECHECK_MS);
    return () => clearInterval(t);
  }, [active, workerId, callId]);

  // The card opens the tab on the agent its row named.
  const asked = ui.panelData?.[tabId]?.agentKey ?? null;
  const [picked, setPicked] = useState(asked);
  useEffect(() => { if (asked) setPicked(asked); }, [asked]);
  const selected = model.agents.find((a) => a.key === picked)
    ?? model.agents.find((a) => a.state === "running")
    ?? model.agents.at(-1)
    ?? null;

  if (!ref) return null;
  if (entry?.fetched && !entry.detail && !entry.live) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon"><WorkflowIcon size={14} /></span>
        <span className="empty-state__title">{entry.error ? "Couldn't load this workflow run" : "This workflow run is no longer available"}</span>
        {entry.error && <span className="empty-state__subtitle">{entry.error}</span>}
        <button className="empty-state__action" onClick={() => ui.closeTab(tabId)}>Close tab</button>
      </div>
    );
  }

  const worker = live?.workers?.find((w) => w.id === workerId);
  const runId = entry?.detail?.runId;
  return (
    <div className="wr-panel">
      <header className="wr-panel__head">
        <div className="wr-panel__title">
          <WorkflowIcon />
          <h2 className="wr-panel__name">{model.name}</h2>
          <StatusChip status={model.status} />
          <span className="wr-spacer" />
          {model.elapsedMs != null && <span className="wr-elapsed">{fmtTime(model.elapsedMs)}</span>}
          {model.canStop && <StopButton workerId={workerId} callId={callId} />}
        </div>
        {model.description && <p className="wr-desc">{model.description}</p>}
        <span className="wr-panel__meta">{[runId, totalsLine(model.totals)].filter(Boolean).join(" · ")}</span>
      </header>
      {model.phases.length > 0
        ? <WorkflowGraph phases={model.phases} selected={selected?.key ?? null} onSelect={setPicked} />
        : <p className="wr-panel__note">{active ? "Waiting for the first agent…" : "This run reported no agents."}</p>}
      {!model.active && model.logs.length > 0 && <div className="wr-panel__log"><RunLog logs={model.logs} /></div>}
      {selected && (
        <AgentDrawer
          key={selected.key}
          agent={selected}
          phase={model.phases.find((p) => p.index === (selected.phaseIndex ?? 0))}
          workerId={workerId}
          callId={callId}
          cwd={worker?.cwd}
          workers={live?.workers ?? []}
        />
      )}
    </div>
  );
}

const PHASE_COUNT = {
  pending: () => "not started",
  running: (p) => `${p.counts.done + p.counts.failed} of ${p.counts.total}`,
  done: () => "done",
  error: (p) => `${p.counts.failed} failed`,
  stopped: (p) => `${p.counts.stopped} stopped`,
};

function WorkflowGraph({ phases, selected, onSelect }) {
  return (
    <div className="wr-graph">
      {phases.map((p, i) => (
        <Fragment key={p.index}>
          {i > 0 && <span className={"wr-link" + (p.state === "running" ? " is-live" : "")} aria-hidden="true" />}
          <section className={`wr-col is-${p.state}`} aria-label={p.title}>
            <header className="wr-col__head">
              <div className="wr-rail__top">
                <span className="wr-rail__n">{String(p.index).padStart(2, "0")}</span>
                <span className="wr-rail__title">{p.title}</span>
                <span className="wr-col__count">{PHASE_COUNT[p.state](p)}</span>
              </div>
              <div className="wr-bar"><span className="wr-bar__fill" style={{ width: `${Math.round((p.state === "done" ? 1 : p.progress) * 100)}%` }} /></div>
              {p.detail && <p className="wr-col__detail">{p.detail}</p>}
            </header>
            <div className="wr-col__nodes">
              {p.agents.map((a) => (
                <button key={a.key} type="button" className={"wr-node" + (a.key === selected ? " is-selected" : "")} aria-pressed={a.key === selected} onClick={() => onSelect(a.key)}>
                  <AgentGlyph agent={a} />
                  <span className="wr-node__text">
                    <span className={"wr-node__label" + (a.state === "queued" ? " is-queued" : "")}>{a.label}</span>
                    <span className={"wr-node__activity" + (a.state === "running" ? " ti-shimmer" : a.state === "error" ? " is-error" : "")}>{a.activity}</span>
                  </span>
                  <span className="wr-node__time">{a.state === "queued" ? "queued" : fmtTime(a.elapsedMs)}</span>
                </button>
              ))}
              {p.agents.length === 0 && <span className="wr-col__empty">{p.state === "pending" ? "Not started" : "No agents"}</span>}
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}

const AGENT_CHIP = { queued: "queued", running: "running", done: "completed", error: "failed", cancelled: "stopped" };
// Refetch a working agent's transcript at most this often (its progress ticks faster).
const ROWS_EVERY_MS = 2000;

function AgentDrawer({ agent, phase, workerId, callId, cwd, workers }) {
  const [rows, setRows] = useState(null);
  const tick = Math.floor((agent.lastProgressAt ?? 0) / ROWS_EVERY_MS);
  useEffect(() => {
    if (!agent.agentId) return undefined;
    let gone = false;
    api.getWorkflowAgentRows(workerId, callId, agent.agentId)
      .then((r) => { if (!gone) setRows(r ?? []); })
      .catch(() => { if (!gone) setRows([]); });
    return () => { gone = true; };
  }, [workerId, callId, agent.agentId, tick]);
  const blocks = useMemo(
    () => (rows ? buildBlocks(rows).filter((b) => b.kind === "tool" || b.kind === "toolGroup" || b.kind === "assistant") : []),
    [rows],
  );
  const meta = [
    phase?.index ? phase.title : null,
    agent.model,
    agent.elapsedMs != null ? fmtTime(agent.elapsedMs) : null,
    agent.tokens ? `${fmtTokens(agent.tokens)} tokens` : null,
    agent.toolCalls ? `${agent.toolCalls} tool uses` : null,
  ].filter(Boolean).join(" · ");
  const outcome = agent.state === "error" ? agent.error : agent.resultPreview;
  const pathLinks = usePathLinks({ cwd });

  return (
    <section className="wr-drawer" aria-label={agent.label}>
      <div className="wr-drawer__head">
        <AgentGlyph agent={agent} size={16} />
        <h3 className="wr-drawer__name">{agent.label}</h3>
        <StatusChip status={AGENT_CHIP[agent.state] ?? agent.state} />
      </div>
      {meta && <span className="wr-drawer__meta">{meta}</span>}
      <div className="wr-drawer__body">
        {agent.promptPreview && (
          <div className="wr-drawer__part">
            <span className="wr-label">Task</span>
            <p className="wr-drawer__text">{agent.promptPreview}</p>
          </div>
        )}
        {outcome && (
          <div className="wr-drawer__part">
            <span className="wr-label">{agent.state === "error" ? "Error" : "Result"}</span>
            <p className={"wr-drawer__text wr-mono" + (agent.state === "error" ? " is-error" : "")}>{outcome}</p>
          </div>
        )}
        <div className="wr-drawer__part">
          <span className="wr-label">Activity</span>
          {!agent.agentId
            ? <p className="wr-drawer__note">Starts when an earlier agent hands it work.</p>
            : rows === null
              ? <p className="wr-drawer__note">Loading…</p>
              : blocks.length === 0
                ? <p className="wr-drawer__note">No activity yet.</p>
                : (
                  <div className="wr-activity" {...pathLinks.handlers}>
                    {blocks.map((b, i) => (b.kind === "assistant"
                      ? <div key={`a${i}`} className="wr-activity__text"><MessageAssistant text={b.text} cwd={cwd} /></div>
                      : <ToolBlock key={(b.tool ?? b.tools[0]).id} block={b} cwd={cwd} workers={workers} />))}
                    {pathLinks.layer}
                  </div>
                )}
        </div>
      </div>
    </section>
  );
}
