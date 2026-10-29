// One glyph per job kind (neutral — colour is kept for status), and the status
// mark at the row's end.

const KIND_PATHS = {
  shell: <><path d="M3 11.5 6.5 8 3 4.5" /><path d="M8 12h5" /></>,
  monitor: <path d="M1.5 8h2.5l2-5 4 10 2-5h2.5" />,
  workflow: <><circle cx="3.5" cy="8" r="2" /><circle cx="12.5" cy="3.5" r="2" /><circle cx="12.5" cy="12.5" r="2" /><path d="M5.5 8H8M8 3.5v9M8 3.5h2.5M8 12.5h2.5" /></>,
  transfer: <><path d="M4.5 11.5 11.5 4.5" /><path d="M6 4.5h5.5V10" /></>,
  compaction: <path d="M3 9.5h3.5V13M13 6.5H9.5V3M9.5 6.5l4-4M2.5 13.5l4-4" />,
  dream: <path d="M13.5 9.6A5.6 5.6 0 1 1 6.4 2.5a4.4 4.4 0 0 0 7.1 7.1z" />,
  sync: <path d="M13 7a5 5 0 0 0-9-2.6L3 5.5M3 2.5v3h3M3 9a5 5 0 0 0 9 2.6l1-1.1M13 13.5v-3h-3" />,
  update: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v5.6M5.6 8.4 8 10.8l2.4-2.4" /></>,
};

export function JobGlyph({ kind }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {KIND_PATHS[kind] ?? KIND_PATHS.shell}
    </svg>
  );
}

const STATUS_LABEL = { completed: "Succeeded", failed: "Failed", stopped: "Stopped" };

export function JobStatus({ status }) {
  if (status === "running") return <span className="jb-spin" role="img" aria-label="Running" />;
  return (
    <svg className={`jb-status jb-status--${status}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={STATUS_LABEL[status]}>
      {status === "completed" && <path d="M3.5 8.5 6.5 11.5 12.5 5" />}
      {status === "failed" && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      {status === "stopped" && <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />}
    </svg>
  );
}
