// The user's profile as ~/.eos/profile/profile.json, and its avatar as
// ~/.eos/profile/avatar.<png|jpeg|webp>. Profile is read once and cached (the daemon
// is the only writer); a file that no longer validates reads as "never saved"
// rather than taking prompt assembly down.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  AvatarExtSchema, UserProfileSchema, type UserProfile,
} from "../../../contracts/src/profile.ts";
import type {
  UserAvatar, UserAvatarStore, UserProfileStore,
} from "../../../core/src/ports/UserProfileStore.ts";
import { writeFileAtomic } from "./atomic-file.ts";

export class FileUserProfileStore implements UserProfileStore {
  private readonly path: string;
  private cached: UserProfile | null | undefined;

  constructor(dir: string) {
    this.path = join(dir, "profile.json");
  }

  get(): UserProfile | null {
    if (this.cached === undefined) this.cached = this.load();
    return this.cached;
  }

  put(profile: UserProfile): void {
    const parsed = UserProfileSchema.parse(profile);
    writeFileAtomic(this.path, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cached = parsed;
  }

  private load(): UserProfile | null {
    if (!existsSync(this.path)) return null;
    try {
      const r = UserProfileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }
}

export class FileUserAvatarStore implements UserAvatarStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  read(): UserAvatar | null {
    for (const ext of AvatarExtSchema.options) {
      const path = this.fileOf(ext);
      if (existsSync(path)) return { bytes: readFileSync(path), ext };
    }
    return null;
  }

  write(avatar: UserAvatar): void {
    writeFileAtomic(this.fileOf(avatar.ext), avatar.bytes);
    for (const ext of AvatarExtSchema.options) {
      if (ext !== avatar.ext) rmSync(this.fileOf(ext), { force: true });
    }
  }

  remove(): void {
    for (const ext of AvatarExtSchema.options) rmSync(this.fileOf(ext), { force: true });
  }

  private fileOf(ext: string): string {
    return join(this.dir, `avatar.${ext}`);
  }
}
