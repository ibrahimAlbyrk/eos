import type { Entry, ToolbarInfo } from "./types";

const TOOLBAR_MEMORY = 64;

// What each artifact's floating toolbar says (the renderer sets it), and the
// message that puts it on the view (preload/artifactOverlay.ts).
export class Toolbars {
  private readonly infos = new Map<string, ToolbarInfo>();

  // A bounded memory; an artifact with a live view keeps its entry.
  set(slug: string, info: ToolbarInfo, live: (slug: string) => boolean): void {
    this.infos.delete(slug);
    this.infos.set(slug, info);
    if (this.infos.size > TOOLBAR_MEMORY) {
      for (const key of this.infos.keys()) {
        if (this.infos.size <= TOOLBAR_MEMORY) break;
        if (!live(key)) this.infos.delete(key);
      }
    }
  }

  send(e: Entry): void {
    if (e.disposed) return;
    const info = this.infos.get(e.slug);
    const visible = e.placement.kind === "tab" && e.state === "ready" && !e.capturing && info != null;
    try {
      e.view.webContents.send("artifactOverlay:set", {
        visible,
        peek: e.placement.kind === "peek",
        initial: info?.initial ?? "",
        account: info?.account ?? "",
        meta: info?.meta ?? "",
      });
    } catch {
      // closing
    }
  }
}
