// Read/write the .eos-stamp files that live inside artifacts.

import { readFileSync, writeFileSync } from "node:fs";

export function readStampFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeStampFile(path: string, stamp: string): void {
  writeFileSync(path, `${stamp}\n`);
}
