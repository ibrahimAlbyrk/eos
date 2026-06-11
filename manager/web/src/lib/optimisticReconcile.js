// Which outbox items (bubbles/pills) are settled and must be dropped?
// Keyed items (clientMsgId) settle ONLY on their id echo — never on text:
// identical texts recur (retries, repeated test sends), and an OLDER
// same-text user_message in the fetched window would silently kill a live
// item. Unkeyed items (spawn prompts, server-materialized pills) keep the
// either-way text-prefix fallback (attachments append suffixes). Both kinds
// drop on a delivery_failed recorded after the send (the red line replaces
// the bubble) and on TTL (an item nothing ever settled must not pin the UI).

export const OPTIMISTIC_TTL_MS = 10 * 60 * 1000;

export function filterOptimistic(list, { ids, texts, failures = [], now = null }) {
  return list.filter((m) => {
    if (m.clientMsgId && ids?.has(m.clientMsgId)) return false;
    const mAgent = m.agentText || m.text;
    if (!m.clientMsgId) {
      for (const st of texts ?? []) {
        if (mAgent === st || st.startsWith(mAgent) || mAgent.startsWith(st)) return false;
        if (m.text === st || st.startsWith(m.text) || m.text.startsWith(st)) return false;
      }
    }
    for (const f of failures) {
      // f.text is a 120-char preview of the text sent to the PTY.
      if (f.ts >= m.ts && (mAgent === f.text || mAgent.startsWith(f.text))) return false;
    }
    if (now != null && now - m.ts > OPTIMISTIC_TTL_MS) return false;
    return true;
  });
}
