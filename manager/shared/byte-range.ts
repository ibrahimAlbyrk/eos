// Single-range `bytes=a-b` parser. WebKit refuses to seek <video>/<audio>
// served without Range support, so fs-raw honors it.

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(header: string | undefined, size: number): ByteRange | null {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Math.min(Number(m[2]), size);
    if (suffix === 0) return null;
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return null;
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (end < start) return null;
  return { start, end };
}
