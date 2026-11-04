// Whether this install may update itself, and from what: only a packaged
// release build (its Resources/update.json says so) running from an app bundle
// in a folder this user can write to. Everything else is `off` with the reason.

import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  UPDATE_BUILD_INFO_FILE, UpdateBuildInfoSchema, type UpdateOffReason, type UpdatePlatform,
} from "../../../contracts/src/update.ts";
import type { AppUpdatePlatform } from "../../../infra/src/platform/HostPlatform.ts";

export interface UpdateInstall {
  readonly version: string;
  // The installed app bundle (…/Eos.app).
  readonly root: string;
  readonly platform: UpdatePlatform;
}

export type ResolvedInstall = { install: UpdateInstall; off: null } | { install: null; off: UpdateOffReason };

export function resolveInstall(opts: {
  packaged: boolean;
  resourcesDir: string;
  execPath: string;
  platform: AppUpdatePlatform | null;
}): ResolvedInstall {
  if (!opts.platform) return { install: null, off: "platform" };
  if (!opts.packaged) return { install: null, off: "dev-build" };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(opts.resourcesDir, UPDATE_BUILD_INFO_FILE), "utf8"));
  } catch {
    return { install: null, off: "dev-build" };
  }
  const info = UpdateBuildInfoSchema.safeParse(raw);
  const root = opts.platform.bundleRoot(opts.execPath);
  if (!info.success || !root) return { install: null, off: "dev-build" };

  // The swap renames the bundle in its folder and the bundle itself.
  try {
    accessSync(dirname(root), constants.W_OK);
    accessSync(root, constants.W_OK);
  } catch {
    return { install: null, off: "read-only" };
  }
  return { install: { version: info.data.version, root, platform: info.data.platform }, off: null };
}
