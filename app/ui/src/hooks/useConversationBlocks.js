// useConversationBlocks — the blocks the side lists (subagents, artifacts) read,
// for the WHOLE conversation, not just the paged event window. While older pages
// are unloaded (or a compaction folds the history away) the rows that rebuild
// every subagent and Artifact call are fetched in full, joined with the window's
// own rows and run through the same parse pipeline — so the Subagents panel and
// the Environment popover list every one, wherever the transcript is scrolled to.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { buildBlocks, applyRewinds, applyClears, applyRecalls } from "../lib/messageParser.js";

// The fetched rows live here (module scope), per chat, so a switch-back or a
// remounted pane reuses them. Bounded like eventsStore's windows: the chats
// shown least recently go first, past MAX_CACHED_CHATS or MAX_CACHED_ROWS (a
// heavy chat holds ~13k rows). coveredTo is the newest window row the snapshot
// was taken against: once the window starts after it, the rows in between are
// in neither, so the chat is fetched again.
const MAX_CACHED_CHATS = 5;
const MAX_CACHED_ROWS = 40_000;
const fetchedByWorker = new Map(); // workerId → { rows, coveredTo }; insertion order = recency

export function cachedConversationRows(workerId) {
  return fetchedByWorker.get(workerId) ?? null;
}

export function rememberConversationRows(workerId, rows, coveredTo) {
  fetchedByWorker.delete(workerId);
  fetchedByWorker.set(workerId, { rows, coveredTo });
  let total = 0;
  for (const e of fetchedByWorker.values()) total += e.rows.length;
  for (const [id, e] of fetchedByWorker) {
    if (fetchedByWorker.size === 1 || (fetchedByWorker.size <= MAX_CACHED_CHATS && total <= MAX_CACHED_ROWS)) break;
    fetchedByWorker.delete(id);
    total -= e.rows.length;
  }
}

function touch(workerId) {
  const e = fetchedByWorker.get(workerId);
  if (!e) return;
  fetchedByWorker.delete(workerId);
  fetchedByWorker.set(workerId, e);
}

export const coversWindow = (fetched, windowStart) => fetched != null && windowStart <= fetched.coveredTo;

export function useConversationBlocks(workerId, events, windowBlocks, { partial, bootPromptOffset }) {
  // Re-renders this pane once its fetch lands in the cache.
  const [, setLanded] = useState(0);
  const fetched = workerId ? cachedConversationRows(workerId) : null;

  const windowStart = useMemo(() => events.reduce((min, e) => Math.min(min, e.id), Infinity), [events]);
  const windowEnd = events.length ? events[events.length - 1].id : 0;
  const needsFetch = Boolean(workerId && partial && events.length > 0 && !coversWindow(fetched, windowStart));

  useEffect(() => { if (workerId) touch(workerId); }, [workerId]);

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    api.getWorkerSubagentEvents(workerId).then((rows) => {
      if (!Array.isArray(rows)) return;
      // Kept even when the pane moved on meanwhile: a switch-back reuses it.
      rememberConversationRows(workerId, rows, windowEnd);
      if (!cancelled) setLanded((n) => n + 1);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workerId, needsFetch]);

  return useMemo(() => {
    if (!partial || !fetched) return windowBlocks;
    return blocksAcrossConversation(fetched.rows, events, bootPromptOffset);
  }, [partial, fetched, windowBlocks, events, bootPromptOffset]);
}

// Test-only: module state survives between vitest cases otherwise.
export function _resetConversationRows() {
  fetchedByWorker.clear();
}

// The fetched rows older than the window, then the window's own (fresher) rows —
// one parse, so a subagent launched before the window and finished inside it
// still closes.
export function blocksAcrossConversation(fetchedRows, windowEvents, bootPromptOffset) {
  const windowStart = windowEvents.reduce((min, e) => Math.min(min, e.id), Infinity);
  const older = fetchedRows.filter((r) => r.id < windowStart);
  return buildBlocks(applyRecalls(applyRewinds(applyClears(older.concat(windowEvents)), { bootPromptOffset })));
}
