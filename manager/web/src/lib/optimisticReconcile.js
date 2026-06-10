// Which optimistic message bubbles are settled and must be dropped?
// Match priority: clientMsgId (authoritative — the durable user_message event
// echoes the ids the daemon delivered) → text either-way prefix (fallback for
// unkeyed sends; attachments append suffixes) → a delivery_failed recorded
// after the send (the red line replaces the bubble) → TTL (a bubble that
// nothing ever settled must not pin the chat forever).

export const OPTIMISTIC_TTL_MS = 10 * 60 * 1000;

export function filterOptimistic(list, { ids, texts, failures = [], now = null }) {
  return list.filter((m) => {
    if (m.clientMsgId && ids?.has(m.clientMsgId)) return false;
    const mAgent = m.agentText || m.text;
    for (const st of texts ?? []) {
      if (mAgent === st || st.startsWith(mAgent) || mAgent.startsWith(st)) return false;
      if (m.text === st || st.startsWith(m.text) || m.text.startsWith(st)) return false;
    }
    for (const f of failures) {
      // f.text is a 120-char preview of the text sent to the PTY.
      if (f.ts >= m.ts && (mAgent === f.text || mAgent.startsWith(f.text))) return false;
    }
    if (now != null && now - m.ts > OPTIMISTIC_TTL_MS) return false;
    return true;
  });
}
