// The one place that reads process.platform (manager/__tests__/platform-guard.test.ts keeps it that way).

import { darwinPlatform } from "./darwin.ts";
import { genericPlatform } from "./generic.ts";
import { win32Platform } from "./win32.ts";
import type { HostPlatform } from "./HostPlatform.ts";

export type { Argv, CredentialStore, HostFeatures, HostPlatform, KeepAwakeOptions, TerminalShell } from "./HostPlatform.ts";

const ADAPTERS: Record<string, HostPlatform> = { darwin: darwinPlatform, win32: win32Platform };

export const hostPlatform: HostPlatform = ADAPTERS[process.platform] ?? genericPlatform(process.platform);
