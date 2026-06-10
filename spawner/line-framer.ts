// Byte-level line framing for the JSONL tail. The tail advances its file
// offset past whatever it read, so a line caught mid-write (no terminating
// newline yet — common for large assistant messages) would otherwise be
// parsed as broken JSON once and silently lost forever. The framer carries
// the unterminated tail (and any split multi-byte UTF-8 sequence — hence
// Buffer, not string) across reads and only ever emits complete lines.
export class LineFramer {
  private remainder: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const buf = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      const line = buf.toString("utf8", start, nl);
      if (line.length > 0) lines.push(line);
      start = nl + 1;
    }
    // copy, not subarray: a view would pin the whole concat buffer in memory
    this.remainder = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
    return lines;
  }
}
