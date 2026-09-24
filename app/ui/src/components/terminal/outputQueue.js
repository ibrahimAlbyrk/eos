// outputQueue — TerminalView's write sink. While held (xterm not opened yet, or
// the view is hidden and paused) output queues instead of being parsed; release()
// writes it in order. A queue past `cap` is dropped: release() then returns true
// and the caller re-syncs from the server buffer, which holds the same latest
// output. Pure and DOM-free so it's unit-tested without xterm.
export function createOutputQueue(write, cap) {
  const pending = [];
  let bytes = 0;
  let held = true;
  let overflowed = false;

  return {
    push(data) {
      if (!data) return;
      if (!held) { write(data); return; }
      if (overflowed) return;
      pending.push(data);
      bytes += data.length;
      if (bytes > cap) {
        overflowed = true;
        pending.length = 0;
        bytes = 0;
      }
    },
    hold() {
      held = true;
    },
    // Returns true when the queue overflowed and the caller must re-sync.
    release() {
      held = false;
      if (overflowed) {
        overflowed = false;
        return true;
      }
      for (const d of pending) write(d);
      pending.length = 0;
      bytes = 0;
      return false;
    },
  };
}
