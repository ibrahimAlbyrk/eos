import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { deriveVerdict } from "../lib/verdict.js";

const POLL_MS = 10000;

// Verdict for a worker that is NOT the selected agent (whose events Messages
// already loads and publishes): fetch the newest slice of the worker's own
// events and derive locally — same selector as the worker view, so the hub
// chip matches what the worker's own screen shows, including a user-clicked
// /verify that never produced a parent report. SSE-debounced on the worker's
// own activity; light poll as fallback.
export function useWorkerVerdict(workerId, live, { enabled = true } = {}) {
  const [verdict, setVerdict] = useState(null);
  const fetchRef = useRef(null);

  useEffect(() => {
    if (!enabled || !workerId) { setVerdict(null); return; }
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const evs = await api.getWorkerEvents(workerId, { limit: 200, order: "desc" });
        if (!cancelled && Array.isArray(evs)) setVerdict(deriveVerdict(evs));
      } catch {}
    };
    fetchRef.current = fetchOnce;
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(t); fetchRef.current = null; };
  }, [workerId, enabled]);

  useEffect(() => {
    if (!enabled || live.eventSignal.workerId !== workerId) return;
    const t = setTimeout(() => fetchRef.current?.(), 700);
    return () => clearTimeout(t);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId, enabled]);

  return verdict;
}
