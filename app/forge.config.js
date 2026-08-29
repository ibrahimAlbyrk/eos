const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Canonical Eos identity — the Electron app IS Eos now that the migration is
// completing. Output goes to app/out/ ONLY; it never writes to or launches
// /Applications/Eos.app. Don't launch the packaged app while the old native
// Eos.app is still running (they'd share a bundle id and confuse LaunchServices).

// Signing is a NO-OP unless EOS_SIGNING_IDENTITY is set (a "Developer ID
// Application: …" name). Notarization only wires up when Apple API-key env is also
// present — and notarytool still only runs during `make` if the operator opts in.
const signingIdentity = process.env.EOS_SIGNING_IDENTITY;
const entitlements = path.resolve(__dirname, "build", "entitlements.mac.plist");

const osxSign = signingIdentity
  ? {
      identity: signingIdentity,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
    }
  : undefined;

const osxNotarize =
  signingIdentity && process.env.EOS_APPLE_API_KEY && process.env.EOS_APPLE_API_KEY_ID && process.env.EOS_APPLE_API_ISSUER
    ? {
        appleApiKey: process.env.EOS_APPLE_API_KEY,
        appleApiKeyId: process.env.EOS_APPLE_API_KEY_ID,
        appleApiIssuer: process.env.EOS_APPLE_API_ISSUER,
      }
    : undefined;

module.exports = {
  hooks: {
    // The app OWNS its UI build: produce a fresh app/ui/dist before packaging so
    // extraResource copies current assets (eos build no longer builds the web UI).
    // Runs for `package`/`make`; dev `npm start` ensures dist via the ensure:ui script.
    prePackage: async () => {
      execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "ui"), stdio: "inherit" });
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
    asar: true, // pack app/ into app.asar — best practice, and lets @electron/universal
    // merge the two arch slices (avoids its identical-SHA check on loose files).
    icon: path.resolve(__dirname, "build", "icon"), // packager appends .icns
    // Bundle the built web UI into Contents/Resources/dist so the packaged app
    // serves eos://app/ without the source tree (config.ts resolveUiRoot). The UI
    // is the nested package at app/ui.
    extraResource: [path.resolve(__dirname, "ui", "dist")],
    // The packaged app.asar needs only package.json + the bundled entry
    // (.forge-build/{main,preload}.js). Exclude the nested UI package (its
    // node_modules + source ship via extraResource as dist), the TS source, and
    // dev/build artifacts — otherwise Forge sweeps app/ui/node_modules into the
    // bundle (hundreds of MB). Return true to EXCLUDE (packager path-relative to app/).
    // node_modules is excluded too: main/preload are fully bundled by esbuild
    // (only electron + electron-updater are external — electron is the runtime,
    // electron-updater is lazy/optional), so the app needs no node_modules at all.
    ignore: (p) =>
      /^\/(ui|src|verify|out|build|node_modules)(\/|$)/.test(p) ||
      /\.(map|md)$/.test(p) ||
      /^\/(esbuild\.mjs|tsconfig\.json|forge\.config\.js|\.gitignore|package-lock\.json)$/.test(p),
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    // DMG needs the native `appdmg`; opt in with EOS_DMG=1.
    ...(process.env.EOS_DMG === "1" ? [{ name: "@electron-forge/maker-dmg", config: { format: "ULFO" } }] : []),
  ],
  plugins: [],
};
