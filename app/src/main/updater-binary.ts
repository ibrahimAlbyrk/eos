import { app } from "electron";

// Shell-BINARY auto-update (electron-updater / Squirrel.Mac) — plan §G layer 2,
// distinct from the M5 daemon-CONTENT update (updater.ts). This is the M6 hook and
// is INERT unless ALL of: the app is packaged, an update feed is configured
// (EOS_UPDATE_FEED), and electron-updater is installed. Squirrel.Mac additionally
// requires a signed app + a published release artifact — so a production binary
// auto-update is deferred to actual distribution.
//
// electron-updater is intentionally NOT a dependency (it's heavy and inert by
// default); it's marked external in esbuild and lazy-required here, so its absence
// is a graceful no-op. To enable: `npm i electron-updater`, set EOS_UPDATE_FEED to
// a generic release feed URL, and ship a signed build.
export function initBinaryAutoUpdate(): void {
  if (!app.isPackaged) return; // dev never auto-updates the binary
  const feed = process.env.EOS_UPDATE_FEED?.trim();
  if (!feed) return; // no feed configured → inert

  // Non-literal specifier: electron-updater is intentionally uninstalled, so this
  // stays a runtime require (esbuild external) and TS doesn't resolve its types.
  const moduleName = "electron-updater";
  import(moduleName)
    .then((mod) => {
      const autoUpdater = (mod as { autoUpdater?: Record<string, unknown> }).autoUpdater;
      if (!autoUpdater || typeof (autoUpdater as { setFeedURL?: unknown }).setFeedURL !== "function") return;
      const au = autoUpdater as {
        autoDownload: boolean;
        setFeedURL: (o: unknown) => void;
        on: (e: string, cb: () => void) => void;
        quitAndInstall: () => void;
        checkForUpdates: () => Promise<unknown>;
      };
      au.autoDownload = true;
      au.setFeedURL({ provider: "generic", url: feed });
      // The binary-apply that M5 stubbed: install the downloaded shell update +
      // relaunch (Squirrel.Mac). Only fires with a signed app + real feed.
      au.on("update-downloaded", () => au.quitAndInstall());
      au.checkForUpdates().catch(() => {});
    })
    .catch(() => {
      // electron-updater not installed — hook stays inert (documented).
    });
}
