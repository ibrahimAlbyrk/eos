import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { shellPlatform } from "./platform";

// The daemon's "location.get" RPC. Chromium's navigator.geolocation never reaches
// the system's location service inside Electron (nothing asks for the system
// permission, so it just times out), so a small native helper per system
// (ShellPlatform.locationHelper; on macOS the CoreLocation helper
// location/main.swift) asks — prompting once — and prints one fix as JSON.
// Failures reject with an Error whose name the daemon maps to a sentence
// (manager/services/genui/media.ts).

export interface LocationFix {
  lat: number;
  lon: number;
  accuracy: number;
  at: number;
}

// Long enough to answer the first-time prompt; under the daemon's 30 s RPC timeout.
const TIMEOUT_S = 25;

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
  const helper = shellPlatform.locationHelper(TIMEOUT_S);
  if (!helper || !existsSync(helper.file)) return Promise.reject(fail("unsupported", "this build has no location helper"));
  return new Promise((resolve, reject) => {
    execFile(helper.file, helper.args, { timeout: (TIMEOUT_S + 3) * 1000 }, (err, stdout) => {
      if (err && !stdout) return reject(fail("unavailable", err instanceof Error ? err.message : String(err)));
      try {
        resolve(parseFix(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}
