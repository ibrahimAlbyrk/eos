// What the surface screen says, with no React in it.

const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

// The line beside the title: which issue, made when.
export function issueLine(issue, now = Date.now()) {
  if (!issue) return null;
  if (issue.trial) return "Trial issue, made with the trial's data.";
  if (issue.status === "preparing") return "This issue is being made.";
  const when = new Date(issue.createdAt).toDateString() === new Date(now).toDateString()
    ? `printed at ${time(issue.createdAt)}`
    : `printed ${day(issue.createdAt)}, ${time(issue.createdAt)}`;
  return issue.seq == null ? `${when[0].toUpperCase()}${when.slice(1)}.` : `Issue ${issue.seq}, ${when}.`;
}

// One row of the Earlier issues menu.
export function issueLabel(issue) {
  if (issue.trial) return `Trial · ${day(issue.createdAt)}`;
  return issue.seq == null ? day(issue.createdAt) : `No. ${issue.seq} · ${day(issue.createdAt)}`;
}

// An issue made with a design the page no longer uses.
export function olderDesignLine(issue) {
  return `${issue.seq == null ? "This issue" : `Issue ${issue.seq}`}, layout version ${issue.version}`;
}

// The same issue drawn in the design the page uses now.
export function todayDesignLine(issue, current) {
  return `${issue.seq == null ? "This issue" : `Issue ${issue.seq}`} in today's design, layout version ${current}`;
}

export const PAGE_NOTE = "Eos designed this layout once and fills it on every run. What you change here changes the layout, and the next issue follows it.";

// Where the designer's newest version stands (surfaces:design phases).
export function designLine(phase, version) {
  switch (phase) {
    case "checking": return `Checking version ${version}…`;
    case "waiting": return `Version ${version} waits for Eos's window to be checked.`;
    case "failed": return `Version ${version} did not pass its checks.`;
    default: return null;
  }
}

// A probe finding in words (05: readable, narrow, empty).
export function findingLine(finding) {
  const where = finding.part ? `${finding.part}: ` : "";
  return `${where}${finding.detail}`;
}
