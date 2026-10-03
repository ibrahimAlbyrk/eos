// Writes each input stream's chunks in `seq` order. A client keeps several
// inputs in flight, and requests overtake each other on the way (parallel
// connections; over a peer link each one is its own stream the host replays on
// its own socket) — so a chunk can arrive before the one typed ahead of it. It
// waits for that one, but never longer than HOLD_MS: then what is held goes out
// in order and a straggler is written when it lands. Losing a keystroke is
// worse than a late one.

const HOLD_MS = 1000;
// Streams of closed tabs: dropped once this many others are newer.
const MAX_STREAMS = 256;

interface Stream {
  next: number;
  held: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class OrderedInput {
  private readonly streams = new Map<string, Stream>();

  // seq starts at 1 per stream.
  accept(key: string, seq: number, data: string, write: (data: string) => void): void {
    let s = this.streams.get(key);
    if (!s) {
      s = { next: 1, held: new Map(), timer: null };
      while (this.streams.size >= MAX_STREAMS) this.drop(this.streams.keys().next().value as string);
    }
    this.streams.delete(key); // re-insert = most recent
    this.streams.set(key, s);
    if (seq < s.next) { write(data); return; }
    s.held.set(seq, data);
    this.drain(s, write);
    if (s.held.size > 0 && !s.timer) {
      const stream = s;
      stream.timer = setTimeout(() => {
        stream.timer = null;
        for (const at of [...stream.held.keys()].sort((a, b) => a - b)) {
          write(stream.held.get(at)!);
          stream.next = at + 1;
        }
        stream.held.clear();
      }, HOLD_MS);
      stream.timer.unref?.();
    }
  }

  private drain(s: Stream, write: (data: string) => void): void {
    while (s.held.has(s.next)) {
      write(s.held.get(s.next)!);
      s.held.delete(s.next);
      s.next++;
    }
    if (s.held.size === 0 && s.timer) { clearTimeout(s.timer); s.timer = null; }
  }

  private drop(key: string): void {
    const s = this.streams.get(key);
    if (s?.timer) clearTimeout(s.timer);
    this.streams.delete(key);
  }
}
