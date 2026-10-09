import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

// The daemon's "location.get" RPC. Chromium's navigator.geolocation never reaches
// CoreLocation inside Electron (nothing asks macOS for the system permission, so
// it just times out), so a small CoreLocation helper (location/main.swift) asks
// macOS — prompting once — and prints one fix as JSON. Failures reject with an
// Error whose name the daemon maps to a sentence (manager/services/genui/media.ts).

export interface LocationFix {
  lat: number;
  lon: number;
  accuracy: number;
  at: number;
}

// Long enough to answer the first-time prompt; under the daemon's 30 s RPC timeout.
const TIMEOUT_S = 25;
const HELPER = "eos-location";

const NAMES: Record<string, string> = {
  denied: "LocationDenied",
  restricted: "LocationDenied",
  disabled: "LocationDisabled",
  timeout: "LocationTimeout",
  unavailable: "LocationUnavailable",
  unsupported: "LocationUnsupported",
};

function fail(code: string, message: string): Error {
  const err = new Error(message || code);
  err.name = NAMES[code] ?? "LocationUnavailable";
  return err;
}

function helperPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, HELPER) : path.join(app.getAppPath(), ".forge-build", HELPER);
}

export function parseFix(stdout: string): LocationFix {
  let r: Partial<LocationFix> & { error?: string; message?: string };
  try {
    r = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw fail("unavailable", "the location helper printed no result");
  }
  if (r.error) throw fail(r.error, r.message ?? "");
  const { lat, lon, accuracy, at } = r;
  if (![lat, lon, accuracy].every((n) => typeof n === "number" && Number.isFinite(n))) throw fail("unavailable", "no coordinates");
  return { lat: lat as number, lon: lon as number, accuracy: accuracy as number, at: typeof at === "number" ? Math.round(at) : Date.now() };
}

export function readLocation(): Promise<LocationFix> {
  const bin = helperPath();
  if (!existsSync(bin)) return Promise.reject(fail("unsupported", "this build has no location helper"));
  return new Promise((resolve, reject) => {
    execFile(bin, [String(TIMEOUT_S)], { timeout: (TIMEOUT_S + 3) * 1000 }, (err, stdout) => {
      if (err && !stdout) return reject(fail("unavailable", err instanceof Error ? err.message : String(err)));
      try {
        resolve(parseFix(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}
