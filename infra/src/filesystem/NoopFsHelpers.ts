// For systems without desktop integration. Every operation returns "not supported".

import type { FsHelpers } from "./FsHelpers.ts";

const unsupported = async (): Promise<void> => { throw new Error("not supported on this system"); };

export const noopFsHelpers: FsHelpers = {
  canPick: false,
  async pickDirectory(): Promise<string | null> { return null; },
  async pickFiles(): Promise<string[] | null> { return null; },
  async resolveDefaultApp(): Promise<null> { return null; },
  async iconForApp(): Promise<null> { return null; },
  openPath: unsupported,
  revealPath: unsupported,
  openIn: unsupported,
  installedEditors: () => [],
  async iconPathForBundleId(): Promise<null> { return null; },
};
