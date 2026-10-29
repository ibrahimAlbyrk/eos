// Publishes a built Eos.app to the in-app update feed (update-server/): its
// manifest, a pack of the chunks the feed doesn't hold yet, the release notes
// and — last — the signed pointer that makes installed apps see it.
// Plan: docs/updates/00-UPDATES-PLAN.md.
//
// Usage:
//   bash scripts/publish-update.sh <version> --app <Eos.app> [--notes <file.md>] [--platform darwin-arm64] [--dry-run]
//   bash scripts/publish-update.sh <version> --platform win32-x64 --from-release [--notes <file.md>]
//   bash scripts/publish-update.sh --init-key
//
// --from-release takes the app out of the GitHub release's Eos-<platform>.zip
// (what Windows CI attaches once the release is out), the way Eos Setup lays it out.
//
// The signing key is the Keychain item `eos-update-signing` (or EOS_UPDATE_SIGNING_KEY).
// --dry-run builds into app/out/updates/<version>/ and uploads nothing.
// Env: EOS_UPDATE_FEED (default the feed in contracts), UPDATES_SSH_HOST (default zap-server).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  UPDATE_FEED_URL, UPDATE_PLATFORMS, UPDATE_PUBLIC_KEYS, UpdatePlatformSchema, type UpdateManifest, type UpdatePlatform,
} from "../contracts/src/update.ts";
import { compareVersions } from "../core/src/domain/update/version.ts";
import { checkForUpdate } from "../core/src/use-cases/update/CheckForUpdate.ts";
import { buildRelease } from "../infra/src/update/buildRelease.ts";
import { Ed25519UpdateSignature, generateUpdateSigningKey, publicKeyOf } from "../infra/src/update/ed25519.ts";
import { HttpUpdateFeed } from "../infra/src/update/HttpUpdateFeed.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYCHAIN_SERVICE = "eos-update-signing";
const REMOTE_WWW = "/opt/eos-updates/www";
const FEED = process.env.EOS_UPDATE_FEED || UPDATE_FEED_URL;
const SSH_HOST = process.env.UPDATES_SSH_HOST || "zap-server";

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readSigningKey(): string {
  const fromEnv = process.env.EOS_UPDATE_SIGNING_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" }).trim();
  } catch {
    die(`no signing key — run with --init-key once, or set EOS_UPDATE_SIGNING_KEY`);
  }
}

function initKey(): void {
  try {
    execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
    die(`the Keychain already holds ${KEYCHAIN_SERVICE}; a new key would strand every installed app`);
  } catch (e) {
    if ((e as { status?: number }).status === undefined) throw e;
  }
  const { privateKey, publicKey } = generateUpdateSigningKey();
  execFileSync("security", ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "eos", "-w", privateKey]);
  console.log(`stored the private key in the Keychain as ${KEYCHAIN_SERVICE}.`);
  console.log(`public key (add it to UPDATE_PUBLIC_KEYS in contracts/src/update.ts):\n  ${publicKey}`);
}

// The release on the feed now, which this one is built against.
async function currentRelease(platform: UpdatePlatform): Promise<UpdateManifest | null> {
  const feed = new HttpUpdateFeed({ baseUrl: () => FEED });
  const pointer = await checkForUpdate({ feed, signature: new Ed25519UpdateSignature(UPDATE_PUBLIC_KEYS) }, { platform, current: "0.0.0" });
  return pointer ? feed.manifest(pointer.manifest) : null;
}

// The release's zip for `platform`, unpacked; a single top folder is stepped
// into, as Eos Setup does when it installs.
async function appFromRelease(version: string, platform: UpdatePlatform): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eos-publish-"));
  const zip = join(dir, "app.zip");
  execFileSync("gh", ["release", "download", `v${version}`, "-p", `Eos-${platform}.zip`, "-O", zip], { cwd: ROOT, stdio: "inherit" });
  const root = join(dir, "app");
  execFileSync("ditto", ["-x", "-k", zip, root]);
  const top = await readdir(root, { withFileTypes: true });
  return top.length === 1 && top[0].isDirectory() ? join(root, top[0].name) : root;
}

function upload(outDir: string, files: string[], pointerPath: string): void {
  const immutable = files.filter((f) => f !== pointerPath);
  // Relative paths under outDir, recreated under the server's www (-R).
  execFileSync("rsync", ["-aR", "--ignore-existing", ...immutable.map((f) => `./${f}`), `${SSH_HOST}:${REMOTE_WWW}/`], { cwd: outDir, stdio: "inherit" });
  const tmp = `${REMOTE_WWW}/${pointerPath}.tmp`;
  execFileSync("rsync", ["-a", join(outDir, pointerPath), `${SSH_HOST}:${tmp}`], { stdio: "inherit" });
  execFileSync("ssh", [SSH_HOST, `mv ${tmp} ${REMOTE_WWW}/${pointerPath}`], { stdio: "inherit" });
}

async function main(): Promise<void> {
  if (process.argv.includes("--init-key")) return initKey();

  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) die("usage: publish-update.sh <version> --app <Eos.app> [--notes <file>] [--dry-run]");
  const platform = UpdatePlatformSchema.safeParse(arg("--platform") ?? "darwin-arm64");
  if (!platform.success) die(`--platform must be one of ${UPDATE_PLATFORMS.join(", ")}`);
  const appRoot = process.argv.includes("--from-release")
    ? await appFromRelease(version, platform.data)
    : arg("--app") ?? die("--app <Eos.app> or --from-release is required");
  const notesFile = arg("--notes");
  const dryRun = process.argv.includes("--dry-run");

  const signingKey = readSigningKey();
  if (!UPDATE_PUBLIC_KEYS.includes(publicKeyOf(signingKey))) die("the signing key is not one the app trusts (UPDATE_PUBLIC_KEYS)");

  const previous = await currentRelease(platform.data);
  if (previous && compareVersions(version, previous.version) <= 0) die(`the feed already has ${previous.version}`);
  console.log(previous ? `building ${version} against ${previous.version}` : `building ${version} (the feed's first release)`);

  const outDir = join(ROOT, "app", "out", "updates", version);
  await rm(outDir, { recursive: true, force: true });
  const started = Date.now();
  const built = await buildRelease({
    appRoot, version, platform: platform.data, previous, outDir,
    notes: notesFile ? readFileSync(notesFile, "utf8") : null,
    signingKey, now: () => new Date(),
  });
  const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`built in ${((Date.now() - started) / 1000).toFixed(0)}s: ${built.newChunks} new chunks, ${built.wholeFiles} whole files, pack ${mb(built.packBytes)}`);
  console.log(`  ${built.files.join("\n  ")}`);

  if (dryRun) {
    console.log(`dry run — nothing uploaded (${outDir})`);
    return;
  }
  upload(outDir, built.files, built.pointerPath);

  const live = await currentRelease(platform.data);
  if (live?.version !== version) die(`the feed still shows ${live?.version ?? "nothing"} after the upload`);
  console.log(`published ${version} for ${platform.data} at ${FEED}`);
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
