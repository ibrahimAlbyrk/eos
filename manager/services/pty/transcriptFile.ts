import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { TranscriptRows, type TranscriptView } from "./transcriptRows.ts";

// A Claude transcript read while Claude appends to it: a read parses only the
// lines completed since the one before. A file that shrank below what was read,
// was replaced, went back in time or changed before the read offset is read
// again from the start.

// The last bytes before the read offset, compared on every read: a rewrite in
// place that leaves the file bigger shows up here unless it kept them as they were.
const GUARD_BYTES = 4096;

export class TranscriptFile {
  private path: string;
  private opts: { sidechain?: boolean };
  private rows: TranscriptRows;
  private offset = 0; // just past the last whole line
  private guard = Buffer.alloc(0);
  private seen: Pick<Stats, "ino" | "size" | "mtimeMs"> | null = null;
  private view: TranscriptView | null = null;

  constructor(path: string, opts: { sidechain?: boolean } = {}) {
    this.path = path;
    this.opts = opts;
    this.rows = new TranscriptRows(opts);
  }

  // null: the file can't be read (it may not exist yet).
  read(): TranscriptView | null {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return null; }
    let st: Stats, lines: string, tail: string;
    try {
      st = fstatSync(fd);
      const seen = this.seen;
      if (seen && st.ino === seen.ino && st.size === seen.size && st.mtimeMs === seen.mtimeMs) return this.view;
      this.seen = null;
      if (!seen || st.ino !== seen.ino || st.size < this.offset || st.mtimeMs < seen.mtimeMs) this.reset();
      let buf = readRange(fd, this.offset - this.guard.length, st.size);
      if (!buf.subarray(0, this.guard.length).equals(this.guard)) {
        this.reset();
        buf = readRange(fd, 0, st.size);
      }
      const from = this.guard.length;
      const end = Math.max(buf.lastIndexOf(0x0a) + 1, from);
      lines = buf.toString("utf8", from, end);
      tail = buf.toString("utf8", end);
      this.offset += end - from;
      this.guard = Buffer.from(buf.subarray(Math.max(0, end - GUARD_BYTES), end));
    } catch { return null; } finally { closeSync(fd); }
    this.rows.add(lines);
    this.view = this.rows.view(tail);
    this.seen = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    return this.view;
  }

  private reset(): void {
    this.rows = new TranscriptRows(this.opts);
    this.offset = 0;
    this.guard = Buffer.alloc(0);
  }
}

function readRange(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}
