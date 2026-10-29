// FrameApiArtifactSource — one Claude sign-in's claude.ai Artifacts, read from
// the undocumented frame API that Claude Code's own Artifact tool and
// /artifacts screen use (plan docs/artifacts/00-ARTIFACTS-PLAN.md). Same family
// as ClaudeUsageProvider: an Anthropic OAuth endpoint called with the sign-in's
// own token, which is INJECTED per sign-in — never read, logged or returned here.
//
// EMPIRICAL FINDING (verified live): without X-Frame-Surface + X-Frame-CP the
// API answers 404. No claude-code User-Agent or client version is sent: Eos
// doesn't pass itself off as the CLI.
//
// The adapter owns the wire shape: rows that aren't a live artifact with a
// uuid slug are dropped, as the CLI drops them.

import type { ArtifactSource } from "../../../core/src/ports/ArtifactSource.ts";
import type { ArtifactSummary } from "../../../contracts/src/artifacts.ts";
import { artifactViewerUrl, shortIdOf } from "../../../contracts/src/artifact-ids.ts";
import { errMsg } from "../../../contracts/src/util.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const TIMEOUT_MS = 15_000;

export const NO_TOKEN_MESSAGE = "This account isn't signed in — sign in again under Settings › Accounts.";
export const REJECTED_MESSAGE = "Claude no longer accepts this account's sign-in — sign in again under Settings › Accounts.";

export interface FrameApiArtifactSourceDeps {
  /** The sign-in's OAuth access token; null when it has none (signed out, lapsed). */
  token: (loginId: string) => Promise<string | null>;
  /** Renews a token the API rejected; the token is read again afterwards. */
  renew?: (loginId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// Leaves out the fields a row didn't carry instead of keeping them as undefined.
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function toArtifactSummary(raw: unknown, loginId: string): ArtifactSummary | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || r.softDeleted === true) return null;
  const slug = str(r.slug)?.toLowerCase();
  if (!slug || shortIdOf(slug) === null) return null;
  const createdAt = str(r.created_at);
  const updatedAt = str(r.updatedAt) ?? createdAt;
  if (!updatedAt) return null;
  return compact<ArtifactSummary>({
    slug,
    url: artifactViewerUrl(slug),
    title: str(r.title)?.trim() ?? "Untitled",
    favicon: str(r.favicon),
    tint: str(r.tint),
    kind: str(r.type_title) ?? "Page",
    version: str(r.live),
    versionLabel: str(r.label),
    rel: r.rel === "shared" ? "shared" : "mine",
    audience: str(r.audience),
    updatedAt,
    createdAt,
    loginId,
  });
}

export function createFrameApiArtifactSource(deps: FrameApiArtifactSourceDeps): ArtifactSource {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${(deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/frame/frames?limit=200`;

  async function get(token: string, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
          "X-Frame-Surface": "code",
          "X-Frame-CP": "go",
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`The artifacts API didn't answer within ${TIMEOUT_MS / 1000} s.`, { cause: e });
      throw new Error(`Couldn't reach the artifacts API: ${errMsg(e)}`, { cause: e });
    }
  }

  return {
    async list(loginId, signal) {
      const token = await deps.token(loginId);
      if (!token) throw new Error(NO_TOKEN_MESSAGE);
      let res = await get(token, signal);
      if (res.status === 401 && deps.renew) {
        try {
          await deps.renew(loginId);
        } catch {
          throw new Error(REJECTED_MESSAGE);
        }
        const renewed = await deps.token(loginId);
        if (!renewed) throw new Error(NO_TOKEN_MESSAGE);
        // An unchanged token would only be refused again.
        if (renewed === token) throw new Error(REJECTED_MESSAGE);
        res = await get(renewed, signal);
      }
      if (res.status === 401) throw new Error(REJECTED_MESSAGE);
      if (!res.ok) throw new Error(`Couldn't read artifacts (HTTP ${res.status}).`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error("The artifacts API sent an answer Eos can't read.");
      }
      const frames = body && typeof body === "object" ? (body as { frames?: unknown }).frames : undefined;
      if (!Array.isArray(frames)) throw new Error("The artifacts API sent an answer Eos can't read.");
      return frames.map((f) => toArtifactSummary(f, loginId)).filter((a) => a !== null);
    },
  };
}
