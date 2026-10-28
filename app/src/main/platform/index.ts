// The one place in the shell that picks per-system behavior
// (manager/__tests__/platform-guard.test.ts keeps process.platform reads here).

import { darwinShell } from "./darwin";
import { win32Shell } from "./win32";
import type { ShellPlatform } from "./ShellPlatform";

export type { ShellPlatform } from "./ShellPlatform";

export const shellPlatform: ShellPlatform = process.platform === "win32" ? win32Shell : darwinShell;
