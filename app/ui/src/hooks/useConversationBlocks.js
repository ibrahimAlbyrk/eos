// useConversationBlocks — the blocks the side lists (subagents, artifacts) read,
// for the WHOLE conversation, not just the paged event window. While older pages
// are unloaded (or a compaction folds the history away) the rows that rebuild
// every subagent and Artifact call are fetched in full, joined with the window's
// own rows and run through the same parse pipeline — so the Subagents panel and
// the Environment popover list every one, wherever the transcript is scrolled to.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { buildBlocks, applyRewinds, applyClears, applyRecalls } from "../lib/messageParser.js";

export function useConversationBlocks(workerId, events, windowBlocks, { partial, bootPromptOffset }) {
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
    if (!partial || fetched.workerId !== workerId) return windowBlocks;
    return blocksAcrossConversation(fetched.rows, events, bootPromptOffset);
  }, [partial, fetched, workerId, windowBlocks, events, bootPromptOffset]);
}

// The fetched rows older than the window, then the window's own (fresher) rows —
// one parse, so a subagent launched before the window and finished inside it
// still closes.
export function blocksAcrossConversation(fetchedRows, windowEvents, bootPromptOffset) {
  const windowStart = windowEvents.reduce((min, e) => Math.min(min, e.id), Infinity);
  const older = fetchedRows.filter((r) => r.id < windowStart);
  return buildBlocks(applyRecalls(applyRewinds(applyClears(older.concat(windowEvents)), { bootPromptOffset })));
}
