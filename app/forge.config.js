const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readFileSync, rmSync, writeFileSync } = require("node:fs");

// Canonical Eos identity — the Electron app IS Eos now that the migration is
// completing. Output goes to app/out/ ONLY; it never writes to or launches
// /Applications/Eos.app. Don't launch the packaged app while the old native
// Eos.app is still running (they'd share a bundle id and confuse LaunchServices).

// Signing identity: EOS_SIGNING_IDENTITY wins; otherwise the keychain's
// "Developer ID Application" cert, so the release Mac signs with no setup. A stable
// identity is what keeps macOS privacy grants (TCC) across rebuilds — an ad-hoc
// signature is pinned to its cdhash, so every build looked like a new app.
// No identity (a contributor's Mac) ⇒ ad-hoc, see postPackage.
const signingIdentity = process.env.EOS_SIGNING_IDENTITY || findDeveloperIdIdentity();

function findDeveloperIdIdentity() {
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    return out.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const entitlements = path.resolve(__dirname, "build", "entitlements.mac.plist");
// The shipped `claude` binary is a non-Electron JS-runtime exe and needs a broader
// Hardened Runtime set (JIT + unsigned-exec-mem + library-validation off).
const claudeEntitlements = path.resolve(__dirname, "build", "entitlements.claude.plist");

// Notarize only for a release (EOS_NOTARIZE=1, set by scripts/release.sh): it
// uploads to Apple and takes minutes, so an everyday `eos build` only signs.
// Credentials are a notarytool keychain profile, created once with
// `xcrun notarytool store-credentials eos-notary --key … --key-id … --issuer …`.
const notarize = Boolean(signingIdentity) && process.env.EOS_NOTARIZE === "1";

// In-app updates (docs/updates/00-UPDATES-PLAN.md): only a release build —
// release.sh sets EOS_UPDATE_CHANNEL=stable — carries Resources/update.json;
// any other build (eos build, a contributor's make) never updates itself.
const updateChannel = process.env.EOS_UPDATE_CHANNEL || null;
const updateInfoPath = path.resolve(__dirname, ".forge-build", "update.json");

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

const osxSign = signingIdentity
  ? {
      identity: signingIdentity,
      // Per-file entitlements: the app + our native addon get the strict set; the
      // bundled third-party `claude` binary gets the broader set so it can JIT and
      // load its own libs under Hardened Runtime.
      // Notarization needs a secure timestamp, but each one is a ~1s round trip to
      // Apple per file (~1000 files ⇒ 10+ minutes), so non-release builds skip it.
      optionsForFile: (filePath) => ({
        hardenedRuntime: true,
        entitlements: /claude-agent-sdk-[^/]+\/claude$/.test(filePath) ? claudeEntitlements : entitlements,
        ...(notarize ? {} : { timestamp: "none" }),
      }),
    }
  : undefined;

const osxNotarize = notarize
  ? { keychainProfile: process.env.EOS_NOTARY_PROFILE || "eos-notary" }
  : undefined;

module.exports = {
  hooks: {
    // The app OWNS its UI build: produce a fresh app/ui/dist before packaging so
    // extraResource copies current assets (eos build no longer builds the web UI).
    // Runs for `package`/`make`; dev `npm start` ensures dist via scripts/ensure-dev.mjs.
    prePackage: async () => {
      // npm is npm.cmd on Windows, which only a shell runs.
      execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "ui"), stdio: "inherit", shell: isWindows });
      // Assemble the standalone backend that ships under Contents/Resources/daemon:
      // esbuild-bundle the daemon + subprocess entries, then copy the external
      // node_modules (incl. the claude binary) and rebuild node-pty for Electron's ABI.
      execFileSync("node", ["scripts/bundle-daemon.mjs"], { cwd: __dirname, stdio: "inherit" });
      execFileSync("node", ["scripts/assemble-daemon.mjs"], { cwd: __dirname, stdio: "inherit" });
      // This system's native helpers (macOS: screen saver + CoreLocation; Windows: EosHelper).
      const helpers = isMac ? ["build-saver.mjs", "build-location.mjs"] : isWindows ? ["build-helper.mjs"] : [];
      for (const script of helpers) execFileSync("node", [`scripts/${script}`], { cwd: __dirname, stdio: "inherit" });
      if (updateChannel) {
        const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8"));
        writeFileSync(updateInfoPath, JSON.stringify({ version, channel: updateChannel, platform: `${process.platform}-${process.arch}` }));
      } else {
        rmSync(updateInfoPath, { force: true });
      }
    },
    // Ad-hoc identifier fix (the DURABLE Dock-icon fix). Without a Developer ID,
    // Forge does no signing and the app keeps Electron's linker-signed default,
    // whose code-signature Identifier is the generic "Electron" (not the bundle
    // id). LaunchServices then can't resolve the app's identity (registers a NULL
    // bundleID) → no Dock icon / no app presence. Re-sign ad-hoc so each bundle's
    // signature Identifier defaults to its OWN CFBundleIdentifier: the top-level
    // app becomes com.ibrahimalbyrk.eos and each helper com.ibrahimalbyrk.eos.helper.
    // No global --identifier: with --deep it would stamp that one id onto every
    // nested helper/framework (identifier collisions). Skipped when a real signing
    // identity is set — osxSign already produced a proper Developer ID signature
    // (also identified by CFBundleIdentifier), so re-signing would only downgrade it.
    postPackage: async (_config, { outputPaths }) => {
      if (!isMac || signingIdentity) return;
      for (const outDir of outputPaths) {
        const appPath = path.join(outDir, "Eos.app");
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
      }
    },
    // Windows: Eos Setup carries the zip (installer-win/, scripts/build-installer.mjs).
    postMake: async (_config, makeResults) => {
      if (!isWindows) return makeResults;
      const zip = makeResults.flatMap((r) => r.artifacts).find((a) => a.endsWith(".zip"));
      execFileSync("node", ["scripts/build-installer.mjs", zip], { cwd: __dirname, stdio: "inherit" });
      return makeResults;
    },
  },
  packagerConfig: {
    // name drives CFBundleName + CFBundleDisplayName + CFBundleExecutable — all
    // canonical "Eos" (no executableName override, so Finder, the menu bar, and
    // the binary all read "Eos").
    name: "Eos",
    appBundleId: "com.ibrahimalbyrk.eos",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Eos",
    // Shown in macOS's Local Network prompt: the daemon dials other Macs on
    // this network directly (Settings › Remote access, Machines).
    extendInfo: {
      NSLocalNetworkUsageDescription: "Eos connects directly to your other computers on this network so you can control them from here.",
      // Without it macOS denies Apple Events from Eos's agents and terminals without asking.
      NSAppleEventsUsageDescription: "Eos agents and terminals run scripts that control other apps.",
      // Read only while the user has location sharing on (Settings › General › Visual answers).
      NSLocationUsageDescription: "Eos uses your location only when you turn on location sharing, to find places near you.",
      NSLocationWhenInUseUsageDescription: "Eos uses your location only when you turn on location sharing, to find places near you.",
    },
    // pack app/ into app.asar — best practice, and lets @electron/universal merge
    // the two arch slices (avoids its identical-SHA check on loose files). Unpack
    // any native addon (node-pty's pty.node) so dlopen() can load it from a real
    // path — .node files cannot be loaded from inside an asar archive.
    asar: { unpack: "**/*.node" },
    icon: path.resolve(__dirname, "build", "icon"), // packager appends .icns / .ico
    // Bundle the built web UI into Contents/Resources/dist so the packaged app
    // serves eos://app/ without the source tree (config.ts resolveUiRoot). The UI
    // is the nested package at app/ui.
    // Ship the web UI + the standalone backend tree + the prompt/worker-definition
    // libraries into Contents/Resources so process.resourcesPath resolves everything
    // the packaged daemon reads (EOS_BUNDLES_DIR=<res>/daemon, EOS_PROMPTS_DIR=<res>/prompts,
    // EOS_WORKER_DEFINITIONS_DIR=<res>/workers, EOS_CLAUDE_BIN under <res>/daemon/node_modules).
    extraResource: [
      path.resolve(__dirname, "ui", "dist"),
      path.resolve(__dirname, ".forge-build", "daemon"),
      path.resolve(__dirname, "..", "manager", "prompts"),
      path.resolve(__dirname, "..", "manager", "workers"),
      ...(isMac ? [
        path.resolve(__dirname, ".forge-build", "Eos.saver"),
        // The CoreLocation helper behind location sharing (main/location.ts runs it).
        path.resolve(__dirname, ".forge-build", "EosLocation.app"),
        // Native notifications play it by name (main/notifications.ts); macOS finds it in Contents/Resources.
        path.resolve(__dirname, "build", "eos-notification.aiff"),
      ] : []),
      // DPAPI secrets, Recycle Bin, keep-awake, location (main/platform/win32.ts, infra/src/platform/win32.ts).
      ...(isWindows ? [path.resolve(__dirname, ".forge-build", "EosHelper.exe")] : []),
      // Marks a release build: the daemon updates only such an install (manager/services/update/install.ts).
      ...(updateChannel ? [updateInfoPath] : []),
    ],
    // The packaged app.asar needs only package.json + the bundled entry
    // (.forge-build/{main,preload,artifactOverlay}.js). Exclude the nested UI package (its
    // node_modules + source ship via extraResource as dist), the TS source, and
    // dev/build artifacts — otherwise Forge sweeps app/ui/node_modules into the
    // bundle (hundreds of MB). Return true to EXCLUDE (packager path-relative to app/).
    // node_modules is excluded too: main/preload are fully bundled by esbuild
    // (only electron is external — it is the runtime), so the app needs no
    // node_modules at all.
    // The daemon bundle tree ships via extraResource (→ Resources/daemon), so keep
    // it OUT of app.asar (else ~248 MB incl. the claude binary is duplicated).
    // .forge-build/{main,preload,artifactOverlay}.js stay IN — they are the app entry.
    ignore: (p) =>
      /^\/(ui|src|verify|out|build|node_modules|scripts|saver|location|helper-win|installer-win)(\/|$)/.test(p) ||
      /^\/\.forge-build\/(daemon|Eos\.saver|EosLocation\.app|EosHelper\.exe|update\.json)(\/|$)/.test(p) ||
      /\.(map|md)$/.test(p) ||
      /^\/(esbuild\.mjs|tsconfig\.json|forge\.config\.js|\.gitignore|package-lock\.json)$/.test(p),
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "win32"] },
    // DMG needs the native `appdmg`; opt in with EOS_DMG=1.
    ...(process.env.EOS_DMG === "1" ? [{ name: "@electron-forge/maker-dmg", config: { format: "ULFO" } }] : []),
  ],
  plugins: [],
};
