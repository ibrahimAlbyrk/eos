// LaunchAgent adapter for the Eos daemon, shared by the CLI and the Electron app
// (node built-ins only and no .ts-extension imports, so both toolchains accept it).
//
// Why launchd: on stop it reaps the daemon's whole process group (no pattern
// pkill that also hits unrelated Claude sessions), it restarts the daemon after a
// crash, and it is the single source of truth for "is it running".
//
// Restart policy: any death except exit 0 respawns (KeepAlive.SuccessfulExit=false).
// "Crashed" alone is not enough — it ignores SIGKILL, which is how macOS kills a
// process under memory pressure. So the daemon exits 0 on every deliberate stop.
// ThrottleInterval bounds a boot-failure loop (e.g. a broken config.json) to one
// attempt per 5s. The plist is
// kept under ~/.eos, NOT ~/Library/LaunchAgents, so nothing loads it at login —
// the daemon stays tied to whoever started it (the app or the CLI).

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DAEMON_LABEL = "com.ibrahimalbyrk.eos.daemon";

export interface LaunchAgentSpec {
  label: string;
  plistPath: string;
  programArguments: string[];
  env: Record<string, string | undefined>;
  logPath: string;
  // The app this agent belongs to. macOS privacy prompts (Local Network) and
  // System Settings then name that app, and one choice there covers the agent.
  associatedBundleId?: string;
}

// Characters XML 1.0 cannot carry at all — a var holding one is left out.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlString(s: string): string {
  return `<string>${xmlText(s)}</string>`;
}

export function renderPlist(spec: LaunchAgentSpec): string {
  const env = Object.entries(spec.env)
    .filter((e): e is [string, string] => e[1] !== undefined && !XML_INVALID.test(e[0] + e[1]))
    .map(([k, v]) => `<key>${xmlText(k)}</key>${xmlString(v)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${xmlString(spec.label)}
<key>ProgramArguments</key><array>${spec.programArguments.map(xmlString).join("")}</array>
<key>EnvironmentVariables</key><dict>${env}</dict>
<key>StandardOutPath</key>${xmlString(spec.logPath)}
<key>StandardErrorPath</key>${xmlString(spec.logPath)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
${spec.associatedBundleId ? `<key>AssociatedBundleIdentifiers</key><array>${xmlString(spec.associatedBundleId)}</array>\n` : ""}</dict></plist>
`;
}

function serviceTarget(label: string): string {
  return `gui/${process.getuid?.() ?? 0}/${label}`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stderr?: unknown; message?: string };
    return { ok: false, out: String(err.stderr || err.message || "") };
  }
}

/** A booted-out service stays listed until its process has exited. */
export function isLaunchAgentLoaded(label: string): boolean {
  return launchctl(["print", serviceTarget(label)]).ok;
}

export function launchAgentPid(label: string): number | null {
  const r = launchctl(["print", serviceTarget(label)]);
  const m = r.ok ? /^\tpid = (\d+)$/m.exec(r.out) : null;
  return m ? Number(m[1]) : null;
}

/** Asks launchd to stop the service (SIGTERM, SIGKILL after ExitTimeOut) and
 *  returns at once; returns false when it was not loaded. */
export function bootoutLaunchAgent(label: string): boolean {
  return launchctl(["bootout", serviceTarget(label)]).ok;
}

/** bootout + wait until the process (and with it the service) is gone. */
export async function stopLaunchAgent(label: string, timeoutMs: number): Promise<boolean> {
  if (!bootoutLaunchAgent(label)) return true;
  const giveUpAt = Date.now() + timeoutMs;
  while (Date.now() < giveUpAt) {
    if (!isLaunchAgentLoaded(label)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isLaunchAgentLoaded(label);
}

/** Writes the plist (0600 — it carries the caller's env) and loads + starts it.
 *  A still-loaded previous instance (e.g. up but not answering) is stopped first,
 *  since bootstrap fails while the label is loaded. */
export async function startLaunchAgent(spec: LaunchAgentSpec, stopTimeoutMs: number): Promise<void> {
  await stopLaunchAgent(spec.label, stopTimeoutMs);
  mkdirSync(dirname(spec.plistPath), { recursive: true });
  writeFileSync(spec.plistPath, renderPlist(spec), { mode: 0o600 });
  chmodSync(spec.plistPath, 0o600);
  const r = launchctl(["bootstrap", `gui/${process.getuid?.() ?? 0}`, spec.plistPath]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
}
