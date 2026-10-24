import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../state/ui.jsx";
import { ensureJobsLoaded, markJobsSeen, useJobs, useJobsSeenAt } from "../../state/jobsStore.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { api } from "../../api/client.js";
import { groupBySource, hasUnseenFailure, isRunning } from "../../lib/jobs.js";
import { JobRow } from "./JobRow.jsx";
import { useChatName } from "./useChatName.js";

const POP = "jobs";
// With nothing running, the popover shows this many of the newest finished jobs.
const RECENT_FINISHED = 5;

// The header's background-jobs button — the running count and a spinning ring,
// quiet like its neighbours: shown while anything runs in the background, or
// while a failure the user hasn't looked at stands (a red dot). Opens a glass popover of the
// jobs grouped by chat; a row (or "Open Jobs panel") opens the Jobs tab.
export function JobsBeacon({ live }) {
  const ui = useUi();
  const jobs = useJobs() ?? [];
  const seenAt = useJobsSeenAt();
  const btnRef = useRef(null);
  useEffect(() => { ensureJobsLoaded(); }, []);

  const open = ui.openPopover === POP;
  const running = jobs.filter(isRunning).length;
  const failed = hasUnseenFailure(jobs, seenAt);
  if (!running && !failed && !open) return null;

  const toggle = (e) => {
    e.stopPropagation();
    if (open) { ui.closeAllPops(); return; }
    markJobsSeen();
    ui.openPop(POP);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"jb-beacon" + (open ? " is-open" : "")}
        data-popover-trigger={POP}
        aria-expanded={open}
        aria-label={running ? `${running} background job${running === 1 ? "" : "s"} running` : "A background job failed"}
        onClick={toggle}
      >
        {running > 0 && <span className="jb-beacon__n">{running}</span>}
        {running > 0 && <span className="jb-ring" aria-hidden="true" />}
        {failed && <span className="jb-beacon__fail" aria-hidden="true" />}
      </button>
      {open && <JobsPopover anchor={btnRef} live={live} jobs={jobs} />}
    </>
  );
}

function JobsPopover({ anchor, live, jobs }) {
  const ui = useUi();
  const chatName = useChatName(live);
  const now = useClockTick(jobs.some(isRunning));
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, [anchor]);

  const running = jobs.filter(isRunning);
  const finished = jobs.filter((j) => !isRunning(j));
  const shown = running.length ? running : finished.slice(0, RECENT_FINISHED);
  const openPanel = (focus) => {
    ui.closeAllPops();
    ui.openPanel("jobs", focus ? { focus, at: Date.now() } : undefined);
  };
  if (!pos) return null;
  return createPortal(
    <div className="jb-pop glass-pop" data-popover={POP} role="dialog" aria-label="Background jobs" style={{ top: pos.top, right: pos.right }}>
      <div className="jb-pop__list">
        {groupBySource(shown, chatName).map((g) => (
          <section key={g.key}>
            <h3 className="jb-pop__group"><span>{g.label}</span><span className="jb-pop__n">{g.jobs.length}</span></h3>
            {g.jobs.map((job) => <JobRow key={job.id} job={job} now={now} compact onClick={() => openPanel(job.id)} />)}
          </section>
        ))}
      </div>
      <div className="jb-pop__sep" />
      <div className="jb-pop__foot">
        <button type="button" className="jb-pop__btn" onClick={() => openPanel(null)}>Open Jobs panel</button>
        <span className="jb-pop__spacer" />
        {running.length > 0 && finished.length > 0 && <span className="jb-pop__note">{finished.length} finished</span>}
        {finished.length > 0 && <button type="button" className="jb-pop__btn is-quiet" onClick={() => api.clearJobs()}>Clear</button>}
      </div>
    </div>,
    document.body,
  );
}
