// useConversationSubagents — subagents for the WHOLE conversation, not just the
// paged event window. While older pages are unloaded (or a compaction folds the
// history away) the rows that rebuild every subagent are fetched in full, joined
// with the window's own rows and run through the same parse pipeline — so the
// Subagents panel lists every one, wherever the transcript is scrolled to.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { buildBlocks, applyRewinds, applyClears, applyRecalls } from "../lib/messageParser.js";
import { collectSubagents } from "../lib/subagentRuns.js";

export function useConversationSubagents(workerId, events, windowSubagents, { partial, bootPromptOffset }) {
  // coveredTo: the newest window row the snapshot was taken against — the window
  // trimming past it leaves a gap, so it is fetched again.
  const [fetched, setFetched] = useState({ workerId: null, rows: [], coveredTo: 0 });

  const windowStart = useMemo(() => events.reduce((min, e) => Math.min(min, e.id), Infinity), [events]);
  const windowEnd = events.length ? events[events.length - 1].id : 0;
  const stale = fetched.workerId !== workerId || windowStart > fetched.coveredTo;
  const needsFetch = Boolean(workerId && partial && events.length > 0 && stale);

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    api.getWorkerSubagentEvents(workerId).then((rows) => {
      if (cancelled || !Array.isArray(rows)) return;
      setFetched({ workerId, rows, coveredTo: windowEnd });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workerId, needsFetch]);

  return useMemo(() => {
    if (!partial || fetched.workerId !== workerId) return windowSubagents;
    return subagentsAcrossConversation(fetched.rows, events, bootPromptOffset);
  }, [partial, fetched, workerId, windowSubagents, events, bootPromptOffset]);
}

// The fetched rows older than the window, then the window's own (fresher) rows —
// one parse, so a subagent launched before the window and finished inside it
// still closes.
export function subagentsAcrossConversation(fetchedRows, windowEvents, bootPromptOffset) {
  const windowStart = windowEvents.reduce((min, e) => Math.min(min, e.id), Infinity);
  const older = fetchedRows.filter((r) => r.id < windowStart);
  const rows = applyRecalls(applyRewinds(applyClears(older.concat(windowEvents)), { bootPromptOffset }));
  return collectSubagents(buildBlocks(rows));
}
