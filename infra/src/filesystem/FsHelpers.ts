// Desktop integration the daemon reaches through the OS: native pickers, the
// default app for a file, app icons, and opening/revealing paths in other apps.
// One implementation per system (DarwinFsHelpers, NoopFsHelpers); the host
// platform picks it.

import type { EditorId } from "../../../contracts/src/http.ts";

export interface AppInfo {
  bundlePath: string;
  bundleId: string;
  appName: string;
}

export type OpenInTarget = "finder" | EditorId;

export interface FsHelpers {
  /** Native directory/file pickers exist on this system. */
  readonly canPick: boolean;
  pickDirectory(): Promise<string | null>;
  pickFiles(): Promise<string[] | null>;
  resolveDefaultApp(opts: { path?: string; ext?: string }): Promise<AppInfo | null>;
  iconForApp(bundlePath: string, bundleId: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  /** Shows the path selected in the file manager. */
  revealPath(path: string): Promise<void>;
  /** "finder" reveals; an editor opens the path, at the line when it can. */
  openIn(target: OpenInTarget, path: string, line?: number, column?: number): Promise<void>;
  /** The editors installed on this computer, in EDITOR_APPS order. */
  installedEditors(): Array<{ id: EditorId; name: string }>;
  /**
   * Returns the cached PNG path if one exists for this bundleId AND the
   * underlying icon file is on disk. Builds the icon from the cached
   * AppInfo's bundlePath if needed. Returns null only when the icon truly
   * can't be produced (bundle never seen, icon file missing, unsupported system).
   */
  iconPathForBundleId(bundleId: string): Promise<string | null>;
}
