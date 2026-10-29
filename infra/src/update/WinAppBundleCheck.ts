// Windows' check of a staged app. Builds aren't code-signed yet, so trust rests
// on the signed manifest every file was checked against; what is left to see is
// that the staged copy is a whole app and that the installed one carries the
// uninstaller the swap runs as (Eos Setup's --apply).

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import type { AppBundleCheck } from "../../../core/src/ports/Updates.ts";

const APP_EXE = "Eos.exe";
// app/installer-win/src/install.rs UNINSTALLER
const UNINSTALLER = "Uninstall Eos.exe";

export class WinAppBundleCheck implements AppBundleCheck {
  async verify(staged: string, installed: string): Promise<void> {
    if (!(await isFile(join(staged, APP_EXE)))) throw new UpdateError("rejected-bundle", "the new version has no Eos.exe");
    if (!(await isFile(join(installed, UNINSTALLER)))) {
      throw new UpdateError("rejected-bundle", "this copy of Eos wasn't installed by Eos Setup — reinstall it to get updates");
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
