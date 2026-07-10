// replayGate — orders a PTY session's reattach so the restored scrollback and
// the live stream never interleave or double-render. On mount TerminalView both
// subscribes to live pty:data frames AND fetches the server ring buffer; those
// race. The gate resolves the race:
//   - frames arriving before the buffer resolves are HELD (not written), so the
//     replayed scrollback always writes first;
//   - once replayed, every frame whose seq is already covered by the buffer
//     (seq <= the buffer's seq) is dropped — the reattach contract in
//     PtySessionService (replay buffer, then dedup live frames by seq).
// `write(data)` is the sink (TerminalView's open-gated xterm writer). Pure and
// DOM-free so the ordering/dedup is unit-tested without xterm.
export function createReplayGate(write) {
  let replayed = false;
  let lastSeq = 0;
  const queued = [];

  // Write a frame's bytes unless the replayed buffer already covers its seq.
  const accept = (f) => {
    if (f?.seq != null && f.seq <= lastSeq) return;
    write(f?.data ?? "");
    if (f?.seq != null) lastSeq = f.seq;
  };

  return {
    // A live pty:data frame. Held until replay(), then deduped against it.
    frame(f) {
      if (!replayed) { queued.push(f); return; }
      accept(f);
    },
    // The fetched ring buffer ({ seq, data }), or null if it was unavailable
    // (fresh session / 404 / error): with no buffer, lastSeq stays 0 so every
    // held frame writes through. Idempotent — a second call is ignored.
    replay(buffer) {
      if (replayed) return;
      if (buffer?.data) write(buffer.data);
      lastSeq = buffer?.seq ?? 0;
      replayed = true;
      for (const f of queued) accept(f);
      queued.length = 0;
    },
  };
}
