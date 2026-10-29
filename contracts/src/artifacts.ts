// The artifact catalog — every claude.ai Artifact of every Eos Claude sign-in,
// read from the frame API per sign-in (manager/routes/artifacts.ts). Ids and
// URLs: ./artifact-ids.ts.

import { z } from "zod";

export const ArtifactSummarySchema = z.object({
  slug: z.string(), // uuid
  url: z.string(), // https://claude.ai/artifact/<shortId>
  title: z.string(),
  favicon: z.string().optional(), // an emoji
  tint: z.string().optional(), // claude.ai's color name for the artifact ("violet", …)
  kind: z.string(), // its type's title ("Design", "Docs", …), "Page" for a plain page
  version: z.string().optional(), // the live version id; a new publish changes it
  versionLabel: z.string().optional(), // the label given at publish, when one was
  rel: z.enum(["mine", "shared"]),
  audience: z.string().optional(), // "owner" | "users" | "org" | "public"
  updatedAt: z.string(),
  createdAt: z.string().optional(),
  loginId: z.string(), // the Eos sign-in whose list holds it
});
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

// One sign-in's part of the catalog. `error` is set when its last read failed;
// its artifacts then stay from the read before.
export const ArtifactAccountSchema = z.object({
  loginId: z.string(),
  label: z.string(),
  email: z.string().optional(),
  count: z.number(),
  refreshedAt: z.string().optional(),
  error: z.string().optional(),
});
export type ArtifactAccount = z.infer<typeof ArtifactAccountSchema>;

// GET /api/artifacts — newest first across sign-ins.
export const ArtifactCatalogSchema = z.object({
  artifacts: z.array(ArtifactSummarySchema),
  accounts: z.array(ArtifactAccountSchema),
  refreshing: z.boolean(),
});
export type ArtifactCatalog = z.infer<typeof ArtifactCatalogSchema>;

// Bus topic: the catalog changed, read GET /api/artifacts again. Its payload is
// only { refreshing } — the stream also reaches paired computers, the catalog
// (titles, account emails) stays on this Mac's local-only route.
export const ARTIFACTS_TOPIC = "artifacts:change";
