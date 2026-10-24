import { useEffect, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useSidePanelVisible } from "../../state/paneScope.js";
import { ensureJobsLoaded, markJobsSeen, useJobs } from "../../state/jobsStore.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { api } from "../../api/client.js";
import { JOB_FILTERS, filterJobs, isRunning } from "../../lib/jobs.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { JobRow } from "./JobRow.jsx";
import { JobDetail } from "./JobDetail.jsx";
import { useChatName } from "./useChatName.js";

// Side-panel tab: every background job — running, then finished — filtered by
// kind; a row opens to its live output and actions. The beacon's popover opens
// it on one job (panelData.jobs.focus). Plan: docs/background-jobs/00-BACKGROUND-JOBS-PLAN.md.
export function JobsPanel({ live }) {
  const ui = useUi();
  const visible = useSidePanelVisible();
  const jobs = useJobs();
  const [filter, setFilter] = useState("all");
  // { focus, at } — `at` makes the same job asked for twice a new request.
  const request = ui.panelData?.jobs ?? null;
  const [openId, setOpenId] = useState(request?.focus ?? null);
  const chatName = useChatName(live);
  const now = useClockTick(Boolean(jobs?.some(isRunning)));

  useEffect(() => { ensureJobsLoaded(); }, []);
  useEffect(() => { if (request?.focus) { setOpenId(request.focus); setFilter("all"); } }, [request]);
  // On screen, every job here counts as seen.
  useEffect(() => { if (visible) markJobsSeen(); }, [visible, jobs]);

  const all = jobs ?? [];
  const shown = filterJobs(all, filter);
  const running = shown.filter(isRunning);
  const finished = shown.filter((j) => !isRunning(j));

  const row = (job) => (
    <JobRow
      key={job.id}
      job={job}
      now={now}
      source={job.workerId ? chatName(job.workerId) : "Eos"}
      open={openId === job.id}
      onClick={() => setOpenId(openId === job.id ? null : job.id)}
    >
      {openId === job.id && <JobDetail job={job} />}
    </JobRow>
  );

  return (
    <PanelShell type="jobs">
      <div className="jb-filters" role="toolbar" aria-label="Filter jobs">
        {JOB_FILTERS.map((f) => (
          <button key={f.id} type="button" className={"jb-chip" + (filter === f.id ? " is-on" : "")} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="jb-chip__n">{filterJobs(all, f.id).length}</span>
          </button>
        ))}
      </div>
      <div className="jb-list">
        {running.length > 0 && (
          <section>
            <h3 className="jb-group">Running · {running.length}</h3>
            {running.map(row)}
          </section>
        )}
        {finished.length > 0 && (
          <section>
            <h3 className="jb-group">
              <span>Finished · {finished.length}</span>
              <button type="button" className="jb-group__act" onClick={() => api.clearJobs()}>Clear</button>
            </h3>
            {finished.map(row)}
          </section>
        )}
        {jobs && !shown.length && (
          <div className="jb-empty">
            <div className="jb-empty__title">Nothing in the background</div>
            <div className="jb-empty__sub">Shells, Monitors, subagents, workflows, transfers and dreams show up here while they run.</div>
          </div>
        )}
      </div>
    </PanelShell>
  );
}
