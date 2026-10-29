// The artifact catalog's pure parts: merging every sign-in's list into one, and
// telling that an agent just published an artifact.

import type { ArtifactSummary } from "../../../contracts/src/artifacts.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

// Newest first, one row per artifact. Two sign-ins see the same one when it is
// shared from one to the other: the owner's row wins.
export function mergeArtifacts(lists: readonly (readonly ArtifactSummary[])[]): ArtifactSummary[] {
  const bySlug = new Map<string, ArtifactSummary>();
  for (const list of lists) {
    for (const a of list) {
      const seen = bySlug.get(a.slug);
      const better = !seen
        || (seen.rel === "shared" && a.rel === "mine")
        || (seen.rel === a.rel && timeOf(a.updatedAt) > timeOf(seen.updatedAt));
      if (better) bySlug.set(a.slug, a);
    }
  }
  return [...bySlug.values()].sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
}

// Claude Code's Artifact tool answers a publish with the artifact's link, in either form.
const ARTIFACT_LINK = /https:\/\/(?:preview\.)?claude\.(?:ai|com)\/(?:code\/)?artifact\//;

export function announcesArtifact(event: AgentEvent): boolean {
  return event.type === "message"
    && event.blocks.some((b) => b.type === "tool_result" && ARTIFACT_LINK.test(b.content));
}
