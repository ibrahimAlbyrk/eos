// Content-defined chunking (FastCDC-style gear hash). Where a file is cut is
// decided by its own bytes, so an edit moves only the cuts around it and the
// rest of the file still matches the copy that is already installed.
//
// The publisher and every installed app must cut identically: changing the
// table, the sizes or the masks changes every chunk id, which makes it a new
// UPDATE_MANIFEST_FORMAT.

export const CHUNK_MIN = 16 * 1024;
export const CHUNK_AVG = 64 * 1024;
export const CHUNK_MAX = 256 * 1024;

// A stricter mask before the average size and a looser one after it keep sizes
// close to CHUNK_AVG. They test the hash's high bits, which depend on the last
// 32 bytes; the low bits would only see the last few.
const MASK_STRICT = 0xffff8000; // 17 bits
const MASK_LOOSE = 0xfffe0000; // 15 bits

const GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    table[i] = x >>> 0;
  }
  return table;
})();

// Cuts a byte stream fed in slices of any size: push() returns the lengths of
// the chunks that ended inside the slice, end() the length of the last one.
export class ContentChunker {
  private hash = 0;
  private length = 0;

  push(data: Uint8Array): number[] {
    const cuts: number[] = [];
    let hash = this.hash;
    let length = this.length;
    for (let i = 0; i < data.length; i++) {
      length++;
      if (length <= CHUNK_MIN) continue;
      hash = ((hash << 1) + GEAR[data[i]]) >>> 0;
      const mask = length <= CHUNK_AVG ? MASK_STRICT : MASK_LOOSE;
      if ((hash & mask) !== 0 && length < CHUNK_MAX) continue;
      cuts.push(length);
      length = 0;
      hash = 0;
    }
    this.hash = hash;
    this.length = length;
    return cuts;
  }

  end(): number | null {
    const last = this.length;
    this.hash = 0;
    this.length = 0;
    return last > 0 ? last : null;
  }
}

export function chunkLengths(data: Uint8Array): number[] {
  const chunker = new ContentChunker();
  const lengths = chunker.push(data);
  const last = chunker.end();
  if (last !== null) lengths.push(last);
  return lengths;
}
