import { useEffect, useRef } from "react";
import { api } from "../../../api/client.js";

// One user-run shell command (composer `!` mode). Live blocks stream from the
// terminal store while the command runs; the durable block renders from the
// single `terminal` event the daemon appends on completion. Workspace runs
// (no agent selected) stay live-only — they have no durable event.
export function TerminalCard({ block }) {
  const running = block.live && !block.done;
  const outRef = useRef(null);

  // Auto-tail: keep the newest output visible while the command runs.
  useEffect(() => {
    if (running && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [block.output, running]);

  const ok = (block.exitCode ?? 0) === 0;
  return (
    <div className="terminal-card mono">
      <div className="tc-head">
        <span className="tc-prompt" aria-hidden>❯</span>
        <span className="tc-cmd">{block.command}</span>
        {running ? (
          <>
            <span className="tc-spin" aria-label="running" />
            <button
              className="tc-stop"
              title="Stop command"
              onClick={() => api.killTerminal(block.runId)}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          </>
        ) : (
          <span className={ok ? "tc-exit ok" : "tc-exit err"}>
            {ok ? "✓" : `✗ ${block.exitCode}`}
          </span>
        )}
      </div>
      {block.output ? (
        <div className="tc-out" ref={outRef}>{block.output}</div>
      ) : running ? (
        <div className="tc-out tc-out-empty">…</div>
      ) : null}
      {(block.note || block.truncated) && (
        <div className="tc-note">
          {[block.note, block.truncated ? "output truncated" : null].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}
