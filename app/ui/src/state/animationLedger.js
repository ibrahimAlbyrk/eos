// Reveal ledger — records which message blocks have already played their
// blur-in typewriter reveal, keyed by `${sessionId}:${blockId}`. State lives at
// module scope (mirrors thinkingStore.js) so a reveal is NEVER replayed across
// remount, session switch, parking, or SSE growth — a per-instance ref would
// reset on each mount and re-animate. dropWorker keeps the ledger bounded when
// eventsStore evicts a worker's cached window.

const revealed = new Set();   // `${sessionId}:${blockId}` — fully revealed
const wordCounts = new Map(); // `${sessionId}:${blockId}` -> words already on screen

const keyOf = (sessionId, blockId) => `${sessionId}:${blockId}`;

export function wasRevealed(sessionId, blockId) {
  return revealed.has(keyOf(sessionId, blockId));
}

export function markRevealed(sessionId, blockId) {
  revealed.add(keyOf(sessionId, blockId));
}

// Words already on screen for a block — survives the live->durable handoff and
// remount so a block that grows across polls animates only its appended tail.
export function revealedWords(sessionId, blockId) {
  return wordCounts.get(keyOf(sessionId, blockId)) ?? 0;
}

export function setRevealedWords(sessionId, blockId, count) {
  wordCounts.set(keyOf(sessionId, blockId), count);
}

// Drop every entry for a worker — called when eventsStore evicts its window so
// the ledger can't grow unbounded. The `:` delimiter prevents prefix collisions
// between ids where one is a prefix of another.
export function dropWorker(sessionId) {
  const prefix = sessionId + ":";
  for (const k of [...revealed]) if (k.startsWith(prefix)) revealed.delete(k);
  for (const k of [...wordCounts.keys()]) if (k.startsWith(prefix)) wordCounts.delete(k);
}
