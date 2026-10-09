// This Mac's position, asked of the desktop app (macOS location permission),
// with the area around it. current() rejects with an Error saying why when there
// is none: sharing is off, the app isn't running, permission was refused, or no
// fix arrived in time.

import type { LocationResponse } from "../../../contracts/src/genui/spec.ts";

export interface LocationSource {
  // The user's Settings switch (location.share).
  sharing(): boolean;
  // Whether the app is there to ask.
  connected(): boolean;
  current(): Promise<LocationResponse>;
}
