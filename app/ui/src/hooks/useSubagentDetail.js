// useSubagentDetail — one subagent whole (prompt, report, every tool) for its
// detail view, from its summary (state/subagentsStore.js). The transcript's
// loaded window has it when it holds all of its runs; otherwise its own rows are
// asked for (GET /workers/:id/subagents/:callId/events), and asked again when
// its summary moves while it runs — at most every MIN_REFETCH_MS. null until
// the first answer.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { subagentFromRows } from "../lib/conversationLists.js";
import { useLoadedSubagents } from "../state/subagentsStore.js";

export const MIN_REFETCH_MS = 1000;

const sameRuns = (a, b) => a.runs.length === b.runs.length && a.runs.every((r, i) => r.toolUseId === b.runs[i].toolUseId);

// What changes in a summary when the subagent's rows do.
const versionOf = (s) =>
  [s.toolUseId, s.status, s.toolCount, s.lastToolTs, s.endTs, s.runs.length, s.activity?.name, JSON.stringify(s.activity?.input)].join("|");

export function useSubagentDetail(workerId, summary) {
  const loaded = useLoadedSubagents(workerId);
  const fromWindow = useMemo(
    () => loaded.find((s) => s.toolUseId === summary.toolUseId && sameRuns(s, summary)) ?? null,
    [loaded, summary],
  );
  const [fetched, setFetched] = useState(null);
  const lastAsk = useRef(0);
  const version = fromWindow ? null : versionOf(summary);

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const ask = () => {
      lastAsk.current = Date.now();
      api.getSubagentRows(workerId, summary.toolUseId)
        .then((rows) => { if (!cancelled) setFetched(subagentFromRows(rows, summary.toolUseId)); })
        .catch(() => {});
    };
    const wait = lastAsk.current + MIN_REFETCH_MS - Date.now();
    const timer = wait > 0 ? setTimeout(ask, wait) : (ask(), null);
    return () => { cancelled = true; clearTimeout(timer); };
    // summary.toolUseId is part of version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, version]);

  return fromWindow ?? (fetched?.toolUseId === summary.toolUseId ? fetched : null);
}
