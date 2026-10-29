// macOS's own word on a staged app: signed by the same developer team as the
// installed one, its signature intact all the way down, and Gatekeeper would
// open it (the notarization ticket is stapled, so this needs no network).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import type { AppBundleCheck } from "../../../core/src/ports/Updates.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

export class MacAppBundleCheck implements AppBundleCheck {
  async verify(staged: string, installed: string): Promise<void> {
    // Clones carry the installed files' quarantine flag; the staged copy is the
    // app as it was notarized, so the flag goes before macOS judges it.
    await run("xattr", ["-dr", "com.apple.quarantine", staged], { timeout: TIMEOUT_MS }).catch(() => {});
    const [team, stagedTeam] = await Promise.all([teamOf(installed), teamOf(staged)]);
    if (!team) throw new UpdateError("rejected-bundle", "the installed app has no developer signature to compare with");
    if (stagedTeam !== team) throw new UpdateError("rejected-bundle", "the new version is signed by a different developer");
    await check("codesign", ["--verify", "--deep", "--strict", staged], "the new version's signature does not verify");
    await check("spctl", ["--assess", "--type", "execute", staged], "Gatekeeper would not open the new version");
  }
}

// codesign prints its details on stderr; ad-hoc signatures say "not set".
async function teamOf(app: string): Promise<string | null> {
  try {
    const { stderr } = await run("codesign", ["-dv", "--verbose=2", app], { timeout: TIMEOUT_MS });
    const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim();
    return team && team !== "not set" ? team : null;
  } catch {
    return null;
  }
}

async function check(cmd: string, args: string[], message: string): Promise<void> {
  try {
    await run(cmd, args, { timeout: TIMEOUT_MS });
  } catch (e) {
    const detail = (e as { stderr?: string }).stderr?.trim().split("\n").pop();
    throw new UpdateError("rejected-bundle", detail ? `${message}: ${detail}` : message);
  }
}
