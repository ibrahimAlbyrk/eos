// ModelCatalogService — live model list from GET /v1/models, authenticated with
// the user's Claude Code OAuth token (macOS Keychain; ~/.claude/.credentials.json
// elsewhere). The endpoint is metadata-only, so it rides the subscription auth
// without consuming API credits. Results are cached at ~/.eos/models.json;
// a fetch failure (expired token, offline) falls back to the cached list, and the
// web UI keeps its own hardcoded baseline as the final fallback.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Clock } from "../../core/src/ports/Clock.ts";
import type { CatalogModel } from "../../contracts/src/http.ts";
import { CatalogModelSchema } from "../../contracts/src/http.ts";
import { z } from "zod";

const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

const CacheFileSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(CatalogModelSchema),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

export type FetchModels = () => Promise<CatalogModel[]>;

export class ModelCatalogService {
  private readonly file: string;
  private readonly clock: Clock;
  private readonly fetchModels: FetchModels;
  private cache: CacheFile | null;
  private refreshing: Promise<void> | null = null;

  constructor(file: string, clock: Clock, fetchModels: FetchModels = fetchModelsFromApi) {
    this.file = file;
    this.clock = clock;
    this.fetchModels = fetchModels;
    this.cache = this.readDisk();
  }

  /** Cached list; blocks briefly on first-ever run, refreshes in background when stale. */
  async get(): Promise<CatalogModel[]> {
    if (!this.cache) {
      await this.refresh().catch(() => {});
    } else if (this.clock.now() - this.cache.fetchedAt > TTL_MS) {
      void this.refresh().catch(() => {});
    }
    return this.cache?.models ?? [];
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.fetchModels()
      .then((models) => {
        if (!models.length) return;
        this.cache = { fetchedAt: this.clock.now(), models };
        this.writeDisk(this.cache);
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private readDisk(): CacheFile | null {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = CacheFileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private writeDisk(cache: CacheFile): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch {
      // cache is best-effort; in-memory copy still serves this run
    }
  }
}

// The same credential claude CLI maintains: refreshed whenever a session runs,
// so it stays fresh in practice. Never logged, never sent to the web UI.
function readOauthToken(): string | null {
  try {
    const raw =
      process.platform === "darwin"
        ? execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
            encoding: "utf8",
          })
        : readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const token = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    if (!token) return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

async function fetchModelsFromApi(): Promise<CatalogModel[]> {
  const token = readOauthToken();
  if (!token) throw new Error("no usable Claude OAuth token");
  const res = await fetch(MODELS_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`models fetch failed: ${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.data)) throw new Error("models fetch: unexpected response shape");
  return body.data.flatMap((m) => {
    const parsed = CatalogModelSchema.safeParse({
      id: m.id,
      displayName: m.display_name ?? "",
      createdAt: m.created_at ?? "",
      maxInputTokens: m.max_input_tokens ?? null,
      maxTokens: m.max_tokens ?? null,
    });
    return parsed.success ? [parsed.data] : [];
  });
}
