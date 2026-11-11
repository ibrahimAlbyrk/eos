// Deterministic test inputs shared with the Rust tests (same generators in
// update/src/testgen.rs): nothing here comes from a real machine.
import { createHash } from "node:crypto";

// SHA-256 in counter mode over "<seed>:<i>".
export function randomBytes(seed: string, len: number): Buffer {
  const out = Buffer.alloc(len);
  for (let i = 0, at = 0; at < len; i++, at += 32) {
    createHash("sha256").update(`${seed}:${i}`).digest().copy(out, at, 0, Math.min(32, len - at));
  }
  return out;
}

export type Gen =
  | { kind: "random"; seed: string; len: number }
  | { kind: "zeros"; len: number }
  // A random block repeated: periodic data, cuts recur.
  | { kind: "repeat"; seed: string; block: number; len: number }
  // The same block again and again, one byte in every `every` changed per copy:
  // no two chunks are equal, yet the file as a whole compresses well.
  | { kind: "drift"; seed: string; block: number; every: number; len: number }
  // Numbered lines of text: low entropy.
  | { kind: "text"; len: number; tag?: string };

export function generate(g: Gen): Buffer {
  switch (g.kind) {
    case "random": return randomBytes(g.seed, g.len);
    case "zeros": return Buffer.alloc(g.len);
    case "repeat": {
      const block = randomBytes(g.seed, g.block);
      const out = Buffer.alloc(g.len);
      for (let at = 0; at < g.len; at += g.block) block.copy(out, at, 0, Math.min(g.block, g.len - at));
      return out;
    }
    case "drift": {
      const block = randomBytes(g.seed, g.block);
      const out = Buffer.alloc(g.len);
      for (let at = 0; at < g.len; at++) {
        const b = block[at % g.block];
        out[at] = at % g.every === 0 ? (b + Math.floor(at / g.block)) & 0xff : b;
      }
      return out;
    }
    case "text": {
      const parts: string[] = [];
      let n = 0;
      for (let i = 0; n < g.len; i++) {
        const line = `${g.tag ?? "line"} ${i}: the quick brown fox jumps over the lazy dog\n`;
        parts.push(line);
        n += line.length;
      }
      return Buffer.from(parts.join(""), "ascii").subarray(0, g.len);
    }
  }
}

export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
