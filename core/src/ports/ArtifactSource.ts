// One Claude sign-in's claude.ai Artifacts (infra/artifacts/FrameApiArtifactSource).
// list() rejects with an Error whose message is short enough to show the user
// (signed out, upstream failure); the catalog keeps that sign-in's last list.

import type { ArtifactSummary } from "../../../contracts/src/artifacts.ts";

export interface ArtifactSource {
  list(loginId: string, signal?: AbortSignal): Promise<ArtifactSummary[]>;
}
