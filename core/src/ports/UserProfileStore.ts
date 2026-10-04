// The user's profile (~/.eos/profile/profile.json) and its avatar image, as two
// narrow ports. Synchronous like PageStore: the daemon is the only writer, and the
// spawn path reads the profile while assembling a system prompt.

import type { AvatarExt, UserProfile } from "../../../contracts/src/profile.ts";

export interface UserProfileStore {
  // null = never saved.
  get(): UserProfile | null;
  put(profile: UserProfile): void;
}

export interface UserAvatar {
  readonly bytes: Uint8Array;
  readonly ext: AvatarExt;
}

export interface UserAvatarStore {
  read(): UserAvatar | null;
  // Replaces any previous avatar, whatever its type.
  write(avatar: UserAvatar): void;
  remove(): void;
}
