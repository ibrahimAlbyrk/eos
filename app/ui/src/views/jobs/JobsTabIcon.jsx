import { useJobs } from "../../state/jobsStore.js";
import { isRunning } from "../../lib/jobs.js";

// The Jobs tab's icon: a stack of rows, a spinner while anything runs.
export function JobsTabIcon() {
  const jobs = useJobs();
  if (jobs?.some(isRunning)) return <span className="jb-spin jb-spin--tab" aria-hidden="true" />;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="4" rx="1.3" />
      <rect x="2" y="9.5" width="12" height="4" rx="1.3" />
      <path d="M4.5 4.5h3M4.5 11.5h3" />
    </svg>
  );
}
