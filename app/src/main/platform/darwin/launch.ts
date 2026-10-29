import { app } from "electron";
import path from "node:path";
import { DAEMON_LABEL, bootoutLaunchAgent, startLaunchAgent } from "../../../../../infra/src/daemon/launchd";
import { eosHome, type DaemonLaunch } from "../../daemon";

// forge.config.js packagerConfig.appBundleId.
const APP_BUNDLE_ID = "com.ibrahimalbyrk.eos";

// Above the daemon's own shutdown deadline (5s) and launchd's ExitTimeOut (10s).
export const DAEMON_STOP_TIMEOUT_MS = 12_000;

const shellArg = (a: string): string => (path.isAbsolute(a) ? JSON.stringify(a) : a);

// A launchd agent: launchd restarts it after a crash and reaps its process group
// on stop. Runs under bash to lift the fd soft limit to the hard ceiling before
// node starts (the macOS GUI default of 256 is far too low for a process
// supervising many PTYs + watches).
export async function startLaunchdDaemon(launch: DaemonLaunch, logPath: string): Promise<void> {
  const cmd = `ulimit -Sn "$(ulimit -Hn)" 2>/dev/null; exec ${[launch.program, ...launch.args].map(shellArg).join(" ")}`;
  await startLaunchAgent({
    label: DAEMON_LABEL,
    plistPath: path.join(eosHome(), "daemon.plist"),
    programArguments: ["/bin/bash", "-c", cmd],
    env: launch.env,
    logPath,
    // A launch agent isn't exempt from Local Network privacy: without this the
    // packaged daemon (this app's own binary) can be kept off the LAN with no
    // prompt naming Eos, and every direct link to another Mac fails.
    ...(app.isPackaged ? { associatedBundleId: APP_BUNDLE_ID } : {}),
  }, DAEMON_STOP_TIMEOUT_MS);
}

export function stopLaunchdDaemon(): void {
  bootoutLaunchAgent(DAEMON_LABEL);
}
