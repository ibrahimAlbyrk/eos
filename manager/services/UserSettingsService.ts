// UserSettingsService — flat key→value store for user UI settings at
// ~/.eos/settings.json. The web settings registry owns key semantics
// and defaults; the daemon only persists. Re-read on every call, no cache,
// atomic write (tmp + rename) so the file stays hand-editable.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { UserSettings } from "../../contracts/src/http.ts";
import { UserSettingsSchema } from "../../contracts/src/http.ts";

export class UserSettingsService {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): UserSettings {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = UserSettingsSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  patch(partial: UserSettings): UserSettings {
    const merged = { ...this.read(), ...partial };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tmp, this.file);
    return merged;
  }
}
