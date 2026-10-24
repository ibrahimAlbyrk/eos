import { isRunning, jobMeta, pctOf, titleIsCommand } from "../../lib/jobs.js";
import { JobGlyph, JobStatus } from "./JobGlyph.jsx";

// One background job, shared by the beacon's popover (compact: one line) and the
// Jobs tab (a second line with the chat and what is happening now; children =
// its open detail).
export function JobRow({ job, now, source, compact = false, open = false, onClick, children }) {
  const running = isRunning(job);
  const pct = running ? pctOf(job) : null;
  const sub = [source, job.detail ?? (titleIsCommand(job) ? null : job.command)].filter(Boolean).join(" · ");
  const cls = ["jb-row", compact && "jb-row--compact", !running && "is-done", open && "is-open"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <button type="button" className="jb-row__main" onClick={onClick} aria-expanded={compact ? undefined : open}>
        <span className="jb-glyph"><JobGlyph kind={job.kind} /></span>
        <span className="jb-row__text">
          <span className={"jb-row__title" + (titleIsCommand(job) ? " is-mono" : "")}>{job.title}</span>
          {!compact && sub && <span className="jb-row__sub">{sub}</span>}
        </span>
        <span className={"jb-row__meta" + (job.status === "failed" ? " is-err" : "")}>{jobMeta(job, now)}</span>
        <JobStatus status={job.status} />
      </button>
      {pct !== null && <div className="jb-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>}
      {children}
    </div>
  );
}
