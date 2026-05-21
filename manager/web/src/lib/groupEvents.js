// Groups a flat event list into turns and pairs tool calls with their results.

export function groupEvents(events) {
  const turns = [];
  let cur = null;
  for (const e of events) {
    if (e.type === "user") { turns.push({ kind: "user", agent: "user", events: [e] }); cur = null; continue; }
    if (e.type === "system" || e.type === "spawn" || e.type === "complete" || e.type === "msg") { turns.push({ kind: "system", agent: e.agent, events: [e] }); cur = null; continue; }
    if (e.type === "policy") continue;
    if (!cur || cur.agent !== e.agent || cur.kind !== "agent") {
      cur = { kind: "agent", agent: e.agent, events: [] };
      turns.push(cur);
    }
    cur.events.push(e);
  }
  return turns;
}

export function turnBlocks(turn) {
  const events = turn.events;
  const consumed = new Set();
  const pairing = new Map(); // tool idx → result idx

  // Pass 1 — strict id-based pairing. Both sides need an id and it must match.
  const resultByIdAvail = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if ((e.type === "result" || e.type === "error") && e.toolUseId) {
      // Keep only the first unmatched result for an id (defensive).
      if (!resultByIdAvail.has(e.toolUseId)) resultByIdAvail.set(e.toolUseId, i);
    }
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "tool" || !e.toolUseId) continue;
    const j = resultByIdAvail.get(e.toolUseId);
    if (j != null && !consumed.has(j)) {
      pairing.set(i, j);
      consumed.add(i);
      consumed.add(j);
      resultByIdAvail.delete(e.toolUseId);
    }
  }

  // Pass 2 — positional fallback for any tool still unpaired. Walks forward
  // and grabs the next unconsumed result, ignoring whether it has an id (the
  // id mismatch case is what we are recovering from).
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "tool" || consumed.has(i)) continue;
    for (let j = i + 1; j < events.length; j++) {
      if (consumed.has(j)) continue;
      const n = events[j];
      if (n.type === "result" || n.type === "error") { pairing.set(i, j); consumed.add(i); consumed.add(j); break; }
    }
  }

  // Emit blocks in original order, skipping anything already consumed as a
  // result (it's rendered via its tool's pair entry).
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "tool") {
      const j = pairing.get(i);
      if (j != null) out.push({ kind: "toolpair", tool: e, result: events[j] });
      else out.push({ kind: "tool", tool: e });
      continue;
    }
    if (e.type === "result" || e.type === "error") {
      if (consumed.has(i)) continue;
      out.push({ kind: "result", result: e });
      continue;
    }
    if (e.type === "thought") { out.push({ kind: "thought", e }); continue; }
    if (e.type === "text")    { out.push({ kind: "text",    e }); continue; }
  }
  return out;
}
