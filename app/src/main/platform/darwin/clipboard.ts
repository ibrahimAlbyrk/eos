import { clipboard } from "electron";
import { execFile } from "node:child_process";

// Finder's ⌘C lists every copied item's real POSIX path here, as a plist (binary
// or XML) — plutil turns either form into a JSON string array.
async function readFilenamesPlist(): Promise<string[]> {
  try {
    const plist = clipboard.readBuffer("NSFilenamesPboardType");
    if (!plist.length) return [];
    const json = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
      child.stdin?.end(plist);
    });
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// Finder writes a file REFERENCE url here (file:///.file/id=<vol>.<inode>), which
// doesn't resolve as a path — only a plain file url is usable.
function readFileUrl(): string[] {
  try {
    const fileUrl = clipboard.read("public.file-url");
    if (!fileUrl.startsWith("file://")) return [];
    const p = decodeURIComponent(new URL(fileUrl).pathname);
    return p.startsWith("/.file/") ? [] : [p];
  } catch {
    return [];
  }
}

// Finder items copied with ⌘C: their paths, or [] when the clipboard holds none.
export async function copiedFilePaths(): Promise<string[]> {
  const names = await readFilenamesPlist();
  return names.length ? names : readFileUrl();
}
