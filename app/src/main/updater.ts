// Launch auto-update flow, ported from app/main.swift:515-628. Two layers, per
// plan §G: (1) content/daemon updates — the daemon-driven /api/updates/* flow
// with the splash (this file), and (2) shell-binary updates via a signed feed —
// electron-updater, which is M6.
//
// SAFETY: the actual apply (POST /api/updates/apply) SIGTERMs + respawns the
// daemon to rebuild it. Calling it against the live daemon would destroy this
// session, so it is STUBBED here — never POSTed. The relaunch step is gated so a
// self-test can't loop.

export interface UpdateStatus {
  enabled: boolean;
  available: boolean;
  branch?: string;
  currentSha?: string;
  latestSha?: string;
}

export type UpdateState =
  | "checking"
  | "up-to-date"
  | "available"
  | "applying"
  | "waiting-daemon"
  | "reload"
  | "relaunch"
  | "error";

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function checkUpdateStatus(base: string): Promise<UpdateStatus | null> {
  const obj = await getJson(`${base}/api/updates/status`, 4000);
  if (!obj) return null;
  return {
    enabled: obj.enabled === true,
    available: obj.available === true,
    branch: typeof obj.branch === "string" ? obj.branch : undefined,
    currentSha: typeof obj.currentSha === "string" ? obj.currentSha : undefined,
    latestSha: typeof obj.latestSha === "string" ? obj.latestSha : undefined,
  };
}

export async function healthStamp(base: string): Promise<string | null> {
  const obj = await getJson(`${base}/health`, 4000);
  return obj && typeof obj.sourceStamp === "string" ? obj.sourceStamp : null;
}

export interface UpdateHooks {
  base: string;
  onState: (s: UpdateState, detail?: unknown) => void;
  reloadInPlace: () => void;
  relaunchApp: () => void;
  forceAvailable?: boolean; // verify-only: drive the available branch
  allowRelaunch?: boolean; // env-gated: actually call app.relaunch()
}

// The state machine. Mirrors launchAfterHealthy → updateAvailable → runLaunchUpdate,
// with the destructive apply + sourceStamp poll STUBBED (see SAFETY above).
export async function runUpdateFlow(h: UpdateHooks): Promise<void> {
  h.onState("checking");
  const status = await checkUpdateStatus(h.base);
  const available = h.forceAvailable === true || status?.available === true;

  if (!available) {
    h.onState("up-to-date", status);
    return; // native: loadWeb with no splash, no delay
  }
  h.onState("available", status);

  // --- apply: STUBBED. A real POST /api/updates/apply {relaunchApp:false} would
  // rebuild + restart the daemon; deferred to M6 (electron-updater signed feed). ---
  h.onState("applying", { stubbed: true, endpoint: "POST /api/updates/apply", deferredTo: "M6" });

  // --- waiting-daemon: a real apply would poll /health until sourceStamp differs
  // from preDaemon (~4min budget); stubbed so we only read the current stamp. ---
  const preDaemon = await healthStamp(h.base);
  h.onState("waiting-daemon", { preDaemon, note: "sourceStamp poll skipped (apply stubbed)" });

  // Decision (native): a web/daemon-only rebuild reloads in place; a changed shell
  // binary relaunches. Stubbed → relaunch only behind the env gate.
  if (h.allowRelaunch === true) {
    h.onState("relaunch");
    h.relaunchApp();
  } else {
    h.onState("reload");
    h.reloadInPlace();
  }
}
