import { useFeature } from "../../../state/featuresStore.js";

const GIT_FOR_WINDOWS = "https://git-scm.com/downloads/win";

// Agents run their shell commands in sh; on Windows that is Git for Windows'
// bash. Without it, say so above the composer — the daemon checks at start.
export function GitBashNotice() {
  if (useFeature("posixShell")) return null;
  return (
    <div className="q-banner">
      <div className="q-card gitbash-notice">
        <span>Agents need <b>Git for Windows</b> to run shell commands. Install it, then restart Eos.</span>
        <a className="gitbash-link" href={GIT_FOR_WINDOWS} target="_blank" rel="noreferrer">Download</a>
      </div>
    </div>
  );
}
