import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useUi } from "../../state/ui.jsx";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { useOpenMemory } from "../../hooks/useOpenMemory.js";
import { workflowTabId } from "../../lib/panelTabs.js";
import { isRunning } from "../../lib/jobs.js";
import { notify } from "../../lib/notify.js";

const POLL_MS = 1000;
const KEEP_CHARS = 64 * 1024;

// A job's output, read from where the last read stopped: once a second while it
// runs, once more when it ends. Starts over (from 0) whenever the job does.
function useJobOutput(job) {
  const [out, setOut] = useState({ text: "", truncated: false, loaded: false });
  const running = isRunning(job);
  useEffect(() => {
    if (!job.hasOutput) return undefined;
    let cancelled = false;
    let timer = null;
    let next = 0;
    let text = "";
    let truncated = false;
    const read = async () => {
      const r = await api.getJobOutput(job.id, next).catch(() => null);
      if (cancelled) return;
      if (r) {
        if (r.reset) text = "";
        text += r.text;
        truncated ||= r.truncated;
        if (text.length > KEEP_CHARS) { text = text.slice(-KEEP_CHARS); truncated = true; }
        next = r.next;
      }
      setOut({ text, truncated, loaded: true });
      if (running) timer = setTimeout(read, POLL_MS);
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job.id, job.hasOutput, running]);
  return out;
}

// The open row of the Jobs tab: the output's tail, and what can be done with the job.
export function JobDetail({ job }) {
  const out = useJobOutput(job);
  const preRef = useRef(null);
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out.text]);
  return (
    <div className="jb-detail">
      {job.hasOutput && (
        <pre ref={preRef} className="jb-out">
          {out.truncated && <span className="jb-out__cut">… earlier output not shown{"\n"}</span>}
          {out.text || (out.loaded ? <span className="jb-out__empty">No output yet</span> : "")}
        </pre>
      )}
      <JobActions job={job} output={out.text} />
    </div>
  );
}

function JobActions({ job, output }) {
  const ui = useUi();
  const openMemory = useOpenMemory();
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.ok === false) notify.error(r.body?.error ?? "That didn't work");
    } finally {
      setBusy(false);
    }
  };
  const goToChat = () => ui.setSelectedId(job.workerId);
  const askToFix = () => {
    goToChat();
    const what = job.command ?? job.title;
    pushTextHandoff(ui.paneId, `\`${what}\` failed${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""}. Look at its output and fix it.`);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(output); notify.info("Copied"); }
    catch (e) { notify.error(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const running = isRunning(job);
  const actions = [
    running && job.canStop && { id: "stop", label: job.kind === "transfer" ? "Cancel" : "Stop", danger: true, run: () => act(() => api.stopJob(job.id)) },
    job.status === "failed" && job.kind === "shell" && job.workerId && { id: "fix", label: "Ask agent to fix", run: askToFix },
    job.kind === "workflow" && job.workerId && job.callId && { id: "live", label: "Open live view", run: () => ui.openPanel(workflowTabId(job.workerId, job.callId)) },
    job.kind === "transfer" && { id: "transfers", label: "Open transfers", run: () => ui.openPanel("transfer") },
    job.kind === "dream" && { id: "journal", label: "Open journal", run: openMemory },
    job.hasOutput && output && { id: "copy", label: "Copy output", run: copy },
    job.workerId && { id: "chat", label: "Go to chat", run: goToChat },
    !running && { id: "dismiss", label: "Dismiss", run: () => act(() => api.dismissJob(job.id)) },
  ].filter(Boolean);
  if (!actions.length) return null;
  return (
    <div className="jb-actions">
      {actions.map((a) => (
        <button key={a.id} type="button" className={"jb-btn" + (a.danger ? " is-danger" : "")} disabled={busy && (a.id === "stop" || a.id === "dismiss")} onClick={a.run}>
          {a.label}
        </button>
      ))}
    </div>
  );
}
