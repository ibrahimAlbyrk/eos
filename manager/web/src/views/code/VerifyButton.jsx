import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";

// Verify with visible feedback: the action lands in the worker's PTY, so the
// only honest "it worked" signal is the worker going busy. Sent → spinner
// "Verifying…" until the worker returns to idle (the verdict chip then carries
// the result); a failed dispatch flashes "Failed".
export function VerifyButton({ workerId, workerState, className }) {
  const [phase, setPhase] = useState("idle"); // idle | sending | running | failed
  const wentBusyRef = useRef(false);

  useEffect(() => { setPhase("idle"); wentBusyRef.current = false; }, [workerId]);

  useEffect(() => {
    if (phase !== "sending" && phase !== "running") return;
    const busy = workerState === "WORKING" || workerState === "SPAWNING";
    if (busy) {
      wentBusyRef.current = true;
      if (phase === "sending") setPhase("running");
    } else if (wentBusyRef.current) {
      setPhase("idle");
      wentBusyRef.current = false;
    }
  }, [workerState, phase]);

  const click = async () => {
    if (phase === "sending" || phase === "running") return;
    setPhase("sending");
    wentBusyRef.current = false;
    const r = await api.sendWorkerAction(workerId, "verify");
    if (!r.ok) {
      setPhase("failed");
      setTimeout(() => setPhase("idle"), 2500);
    }
  };

  const busy = phase === "sending" || phase === "running";
  return (
    <button
      className={className + (busy ? " verify-busy" : "") + (phase === "failed" ? " verify-failed" : "")}
      disabled={busy}
      title={busy ? "Agent is running the project's checks in its workspace" : "Agent runs the project's checks in its own workspace"}
      onClick={click}
    >
      {busy && <span className="verify-spin" aria-hidden="true" />}
      <span>{phase === "failed" ? "Failed" : busy ? "Verifying…" : "Verify"}</span>
    </button>
  );
}
