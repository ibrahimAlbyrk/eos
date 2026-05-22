// Non-macOS stub. Every operation returns "not supported".

import type { FsHelpers } from "./DarwinFsHelpers.ts";

export const noopFsHelpers: FsHelpers = {
  async pickDirectory(): Promise<string | null> { return null; },
  async resolveDefaultApp(): Promise<null> { return null; },
  async iconForApp(): Promise<null> { return null; },
  async openPath(): Promise<void> { throw new Error("open only supported on darwin"); },
  async iconPathForBundleId(): Promise<null> { return null; },
};
