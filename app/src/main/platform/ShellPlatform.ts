// Everything the desktop shell does differently per operating system.
// `shellPlatform` (index.ts) is chosen once; the rest of the shell reads what
// the system can do from here and never compares platform names itself.

import type { BrowserWindowConstructorOptions } from "electron";
import type { DaemonLaunch } from "../daemon";

export interface ShellPlatform {
  /** The desktop conventions the dashboard follows (command key, shortcut labels, window controls): <html data-os>. */
  readonly uiOS: "mac" | "windows";
  /** Runs first, before the app is ready. false = this launch was only an installer event and the app quits. */
  init(): boolean;
  /**
   * The app-wide menu bar (menu.ts) is the system's: on a Mac its accelerators
   * own ⌘C/⌘V/⌘Z. Without one, no menu is installed, so every key reaches the
   * dashboard — a terminal's Ctrl+C stays an interrupt.
   */
  readonly appMenu: boolean;
  /** Title bar of the main window and host windows (content to the top edge; where it has no system controls the dashboard draws them). */
  windowFrame(): BrowserWindowConstructorOptions;
  /** Material behind the boot splash's transparent window. */
  splashMaterial(): BrowserWindowConstructorOptions;
  /** The daemon's local control plane for an Eos home (infra/src/platform/control-socket.ts). */
  controlSocket(home: string): string;
  /** Runs the daemon under the system's service manager: restarted after a crash, its process tree reaped on stop. */
  startDaemon(launch: DaemonLaunch, logPath: string): Promise<void>;
  /** Asks the service manager to stop the daemon; returns at once. */
  stopDaemon(): void;
  /** The claude binary inside the packaged daemon bundle. */
  claudeBinary(bundlesDir: string): string;
  /** The command that prints one location fix as JSON (location.ts), or null without a helper. */
  locationHelper(timeoutS: number): { file: string; args: string[] } | null;
  /** Paths of files copied in the file manager, or [] when the clipboard holds none. */
  clipboardFilePaths(): Promise<string[]>;
  /** The notification sound shipped with the app, when the system plays custom ones. */
  readonly notificationSound: string | undefined;
  /** Rebuild + relaunch from source (`eos build --app`), or null where the dev CLI doesn't run. */
  readonly rebuild: ((busyAgents: number) => Promise<void>) | null;
  /** Lock with the Eos screen saver, or null on a system without one. */
  readonly screenSaver: { lock(): void; install(): Promise<void> } | null;
}
