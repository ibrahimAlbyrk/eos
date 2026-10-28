import { clipboard } from "electron";

// Explorer's copy puts the first item's path in "FileNameW" (UTF-16). Only that
// one: the full list (CF_HDROP) isn't a format Electron reads.
export async function copiedFilePaths(): Promise<string[]> {
  try {
    const raw = clipboard.readBuffer("FileNameW");
    const p = raw.toString("utf16le").replace(/\0+$/, "");
    return p ? [p] : [];
  } catch {
    return [];
  }
}
