import type { Entry } from "./types";

// Tells the view's preload (preload/artifactOverlay.ts) whether it is the hover
// peek, where a shield takes the page's input.
export function syncOverlay(e: Entry): void {
  if (e.disposed) return;
  try {
    e.view.webContents.send("artifactOverlay:set", { peek: e.placement.kind === "peek" });
  } catch {
    // closing
  }
}
