// Keeps the Mac out of system sleep while the remote edge is armed, so a phone
// can still reach the daemon with the screen locked or off. Only system sleep is
// held — the display still sleeps and the screen still locks.
//
// `caffeinate -s` asserts PreventSystemSleep, which macOS honours on AC power
// only: on battery the Mac sleeps as usual, so this never drains the battery.
// `-w <pid>` ties the assertion to the daemon — if the daemon dies without
// cleaning up, caffeinate exits on its own and the Mac can sleep again.
// Closing the lid still sleeps the Mac unless it runs in clamshell mode (power +
// external display); no user-space assertion can override that.

import { spawn } from "node:child_process";
import type { KeepAwakeOptions } from "./HostPlatform.ts";

export function caffeinateArgs(pid: number): string[] {
  return ["-s", "-w", String(pid)];
}

/** Holds the assertion until the returned release function is called. */
export function startCaffeinate(opts: KeepAwakeOptions, spawnFn: typeof spawn = spawn): () => void {
  const child = spawnFn("/usr/bin/caffeinate", caffeinateArgs(opts.pid), { stdio: "ignore" });
  child.on("error", (e) => opts.log?.("keep-awake failed to start", { error: e.message }));
  child.unref();
  opts.log?.("keep-awake on (system sleep held while on AC power)", { pid: child.pid });
  return () => { child.kill(); };
}
