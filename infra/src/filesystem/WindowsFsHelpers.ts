// Windows desktop integration: Explorer for open/reveal, editors by their
// install paths. Pickers are the desktop app's own dialogs (canPick: false →
// /pick-* asks the app); default apps and app icons aren't resolved yet, so the
// dashboard shows its generic glyphs.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EDITOR_APPS, type EditorId } from "../../../contracts/src/http.ts";
import type { FsHelpers, OpenInTarget } from "./FsHelpers.ts";

const local = (...p: string[]): string => join(process.env.LOCALAPPDATA ?? "", ...p);
const programs = (...p: string[]): string => join(process.env.ProgramFiles ?? "C:\\Program Files", ...p);

// Where each editor's executable lives after its default (user or machine) install.
const EDITOR_EXES: Partial<Record<EditorId, () => string[]>> = {
  vscode: () => [local("Programs", "Microsoft VS Code", "Code.exe"), programs("Microsoft VS Code", "Code.exe")],
  cursor: () => [local("Programs", "cursor", "Cursor.exe")],
  zed: () => [local("Programs", "Zed", "zed.exe")],
  sublime: () => [programs("Sublime Text", "sublime_text.exe")],
};

// Editors that take `--goto <path>:<line>[:<column>]`.
const GOTO_EDITORS = new Set<EditorId>(["vscode", "cursor"]);

function editorExe(id: EditorId, exists: (p: string) => boolean = existsSync): string | null {
  return EDITOR_EXES[id]?.().find((p) => exists(p)) ?? null;
}

export function windowsEditorArgv(target: EditorId, path: string, line?: number, column?: number): string[] {
  if (line && GOTO_EDITORS.has(target)) return ["--goto", `${path}:${line}${column ? `:${column}` : ""}`];
  return [path];
}

export function installedWindowsEditors(exists: (p: string) => boolean = existsSync): Array<{ id: EditorId; name: string }> {
  return (Object.entries(EDITOR_APPS) as Array<[EditorId, string]>)
    .filter(([id]) => editorExe(id, exists) !== null)
    .map(([id, name]) => ({ id, name }));
}

// Explorer exits 1 even when it did what was asked, so only a failed spawn counts.
function launch(file: string, args: string[], verbatim = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: verbatim });
    proc.once("error", reject);
    proc.once("spawn", () => { proc.unref(); resolve(); });
  });
}

const reveal = (path: string): Promise<void> => launch("explorer.exe", [`/select,"${path}"`], true);

export function createWindowsFsHelpers(): FsHelpers {
  return {
    canPick: false,
    async pickDirectory() { return null; },
    async pickFiles() { return null; },
    async resolveDefaultApp() { return null; },
    async iconForApp() { return null; },
    async iconPathForBundleId() { return null; },
    openPath: (path) => launch("explorer.exe", [path]),
    revealPath: reveal,
    async openIn(target: OpenInTarget, path, line, column) {
      if (target === "finder") return reveal(path);
      const exe = editorExe(target);
      if (!exe) throw new Error(`${EDITOR_APPS[target]} is not installed`);
      await launch(exe, windowsEditorArgv(target, path, line, column));
    },
    installedEditors: () => installedWindowsEditors(),
  };
}
