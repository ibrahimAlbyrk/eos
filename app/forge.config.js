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
// The shipped `claude` binary is a non-Electron JS-runtime exe and needs a broader
// Hardened Runtime set (JIT + unsigned-exec-mem + library-validation off).
const claudeEntitlements = path.resolve(__dirname, "build", "entitlements.claude.plist");

const osxSign = signingIdentity
  ? {
      identity: signingIdentity,
      // Per-file entitlements: the app + our native addon get the strict set; the
      // bundled third-party `claude` binary gets the broader set so it can JIT and
      // load its own libs under Hardened Runtime.
      optionsForFile: (filePath) => ({
        hardenedRuntime: true,
        entitlements: /claude-agent-sdk-[^/]+\/claude$/.test(filePath) ? claudeEntitlements : entitlements,
      }),
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
      // Assemble the standalone backend that ships under Contents/Resources/daemon:
      // esbuild-bundle the daemon + subprocess entries, then copy the external
      // node_modules (incl. the claude binary) and rebuild node-pty for Electron's ABI.
      execFileSync("node", ["scripts/bundle-daemon.mjs"], { cwd: __dirname, stdio: "inherit" });
      execFileSync("node", ["scripts/assemble-daemon.mjs"], { cwd: __dirname, stdio: "inherit" });
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
      if (process.platform !== "darwin" || signingIdentity) return;
      for (const outDir of outputPaths) {
        const appPath = path.join(outDir, "Eos.app");
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
      }
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
    // pack app/ into app.asar — best practice, and lets @electron/universal merge
    // the two arch slices (avoids its identical-SHA check on loose files). Unpack
    // any native addon (node-pty's pty.node) so dlopen() can load it from a real
    // path — .node files cannot be loaded from inside an asar archive.
    asar: { unpack: "**/*.node" },
    icon: path.resolve(__dirname, "build", "icon"), // packager appends .icns
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
    ],
    // The packaged app.asar needs only package.json + the bundled entry
    // (.forge-build/{main,preload}.js). Exclude the nested UI package (its
    // node_modules + source ship via extraResource as dist), the TS source, and
    // dev/build artifacts — otherwise Forge sweeps app/ui/node_modules into the
    // bundle (hundreds of MB). Return true to EXCLUDE (packager path-relative to app/).
    // node_modules is excluded too: main/preload are fully bundled by esbuild
    // (only electron + electron-updater are external — electron is the runtime,
    // electron-updater is lazy/optional), so the app needs no node_modules at all.
    // The daemon bundle tree ships via extraResource (→ Resources/daemon), so keep
    // it OUT of app.asar (else ~248 MB incl. the claude binary is duplicated).
    // .forge-build/{main,preload}.js stay IN — they are the app entry.
    ignore: (p) =>
      /^\/(ui|src|verify|out|build|node_modules|scripts)(\/|$)/.test(p) ||
      /^\/\.forge-build\/daemon(\/|$)/.test(p) ||
      /\.(map|md)$/.test(p) ||
      /^\/(esbuild\.mjs|tsconfig\.json|forge\.config\.js|\.gitignore|package-lock\.json)$/.test(p),
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },
  // node-pty ships as a native addon and must match Electron's module ABI (146),
  // not the system Node's. onlyModules scopes the rebuild to it. NOTE (Stage 3):
  // node-pty lives in spawner/node_modules and is shipped under
  // Resources/daemon/node_modules by the (pending) resource-assembly hook; the
  // electron-rebuild there must target that assembled tree. This declaration
  // covers the case where it is present in a rebuild-visible node_modules.
  rebuildConfig: {
    onlyModules: ["node-pty", "@homebridge/node-pty-prebuilt-multiarch"],
    force: true,
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    // DMG needs the native `appdmg`; opt in with EOS_DMG=1.
    ...(process.env.EOS_DMG === "1" ? [{ name: "@electron-forge/maker-dmg", config: { format: "ULFO" } }] : []),
  ],
  plugins: [],
};
