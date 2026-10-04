// UserProfileService — the one write path for the user's profile. Every real change
// bumps `rev` and publishes `profile:change`; a save carrying a stale baseRev is
// refused with the current profile (StaleProfileError → 409) instead of overwriting a
// change made in another window. A save that changes nothing keeps the revision.

import { ConflictError, ValidationError } from "../errors/index.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { UserAvatar, UserAvatarStore, UserProfileStore } from "../ports/UserProfileStore.ts";
import { applyProfilePatch, emptyUserProfile, sameProfileContent, sniffAvatarExt } from "../domain/user-profile.ts";
import {
  AVATAR_MAX_BYTES, type UserProfile, type UserProfileChangeEvent, type UserProfilePatch,
} from "../../../contracts/src/profile.ts";

export class StaleProfileError extends ConflictError {
  readonly profile: UserProfile;
  constructor(profile: UserProfile) {
    super(`profile changed since the revision you edited (now rev ${profile.rev})`);
    this.profile = profile;
  }
}

export interface UserProfileServiceDeps {
  readonly store: UserProfileStore;
  readonly avatars: UserAvatarStore;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
}

// What prompt assembly and the preview depend on — nothing that writes.
export interface UserProfileReader {
  get(): UserProfile;
}

export class UserProfileService implements UserProfileReader {
  private readonly deps: UserProfileServiceDeps;

  constructor(deps: UserProfileServiceDeps) {
    this.deps = deps;
  }

  get(): UserProfile {
    return this.deps.store.get() ?? emptyUserProfile();
  }

  update(patch: UserProfilePatch, baseRev?: number): UserProfile {
    const cur = this.get();
    if (baseRev !== undefined && baseRev !== cur.rev) throw new StaleProfileError(cur);
    const next = applyProfilePatch(cur, patch);
    return sameProfileContent(cur, next) ? cur : this.commit(next);
  }

  avatar(): UserAvatar | null {
    return this.deps.avatars.read();
  }

  setAvatar(bytes: Uint8Array): UserProfile {
    if (!bytes.byteLength) throw new ValidationError("empty image");
    if (bytes.byteLength > AVATAR_MAX_BYTES) throw new ValidationError(`image larger than ${AVATAR_MAX_BYTES / (1024 * 1024)} MB`);
    const ext = sniffAvatarExt(bytes);
    if (!ext) throw new ValidationError("avatar must be a PNG, JPEG or WebP image");
    this.deps.avatars.write({ bytes, ext });
    const cur = this.get();
    return this.commit({ ...cur, identity: { ...cur.identity, avatar: ext } });
  }

  clearAvatar(): UserProfile {
    const cur = this.get();
    if (!cur.identity.avatar) return cur;
    this.deps.avatars.remove();
    return this.commit({ ...cur, identity: { ...cur.identity, avatar: null } });
  }

  private commit(next: UserProfile): UserProfile {
    const saved: UserProfile = { ...next, rev: this.get().rev + 1, updatedAt: this.deps.clock.now() };
    this.deps.store.put(saved);
    const evt: UserProfileChangeEvent = { rev: saved.rev };
    this.deps.bus.publish("profile:change", evt);
    return saved;
  }
}
