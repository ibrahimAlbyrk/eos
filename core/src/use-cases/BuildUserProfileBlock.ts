// BuildUserProfileBlock — what one session gets for {{USER_PROFILE}}: the rendered
// profile + always-on memories for its project, or the stock preferences when the
// user withholds the profile from its backend kind. The spawn path and
// GET /api/profile/preview both call this, so the preview is the real thing.

import type { MemorySnapshot } from "../ports/MemoryProvider.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";
import type { UserProfileReader } from "../services/UserProfileService.ts";
import {
  DEFAULT_USER_PREFERENCES, renderUserProfile, type RenderedUserProfile,
} from "../services/render-user-profile.ts";
import { estimateTokens } from "../domain/compaction.ts";

export interface UserProfileBlockDeps {
  readonly profile: UserProfileReader;
  readonly memories: () => readonly UserMemory[];
}

export interface UserProfileBlockInput {
  // The session's real backend kind (sharing.withholdFrom is a list of kinds).
  readonly kind: string;
  readonly project: string | null;
  // Lines the session already receives from CLAUDE.md-style memory.
  readonly knownLines: readonly string[];
  readonly searchToolName: string | null;
}

export interface UserProfileBlock extends RenderedUserProfile {
  readonly withheld: boolean;
  readonly budgetTokens: number;
}

export function buildUserProfileBlock(deps: UserProfileBlockDeps, input: UserProfileBlockInput): UserProfileBlock {
  const profile = deps.profile.get();
  if (profile.sharing.withholdFrom.includes(input.kind)) {
    return {
      text: DEFAULT_USER_PREFERENCES, tokens: estimateTokens(DEFAULT_USER_PREFERENCES),
      includedIds: [], overflow: 0, empty: true, withheld: true, budgetTokens: profile.budgetTokens,
    };
  }
  const rendered = renderUserProfile(profile, deps.memories(), {
    project: input.project, knownLines: input.knownLines, searchToolName: input.searchToolName,
  });
  return { ...rendered, withheld: false, budgetTokens: profile.budgetTokens };
}

// The memory-doc lines a session of `kind` actually receives: docs its backend loads
// natively (the claude lane reads CLAUDE.md itself), plus every doc Eos injects when
// memory injection is on.
export function receivedMemoryLines(snapshot: MemorySnapshot, kind: string, injected: boolean): string[] {
  return snapshot.docs
    .filter((d) => injected || d.nativeFor.includes(kind))
    .flatMap((d) => d.content.split("\n"));
}
