// Project keys — how a project folder travels between Macs. The same repo usually
// lives at a different path on each Mac, so a memory's scope or a page's project goes
// over the wire as the repo's `origin` remote ("git:github.com/owner/repo", plus
// "#sub/dir" for a folder inside it) and comes back as this Mac's checkout of that
// repo. A folder without a remote travels as "path:<abs>".
//
// A key this Mac can't place yet (the repo isn't cloned here) keeps the sender's
// path, and that path is remembered against the key so editing the record here
// doesn't push the key back as a bare path.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import type { GitInfo } from "../../../core/src/ports/GitInfo.ts";
import { writeFileAtomic } from "../../../infra/src/persistence/atomic-file.ts";

const CACHE_TTL_MS = 10 * 60_000;

export interface ProjectKeys {
  toKey(path: string): Promise<string>;
  toPath(key: string, hint: string): Promise<string>;
  // This Mac's checkout for a git key, or null — never a guess, nothing learned.
  findPath(key: string): Promise<string | null>;
}

// git@github.com:Owner/repo.git · https://user@github.com/Owner/repo · ssh://git@host:22/o/r
// → github.com/Owner/repo (host lowercased, port/user/.git dropped).
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  const full = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const m = scp ?? full;
  if (!m) return null;
  const path = m[2]!.replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^\/+/, "");
  return path ? `${m[1]!.toLowerCase()}/${path}` : null;
}

export interface ProjectKeysDeps {
  readonly git: Pick<GitInfo, "gitDirs" | "remoteUrl">;
  // Folders this Mac knows (projects, recents, agent folders) — where a key is looked for.
  readonly candidates: () => readonly string[];
  // ~/.eos/sync/project-keys.json
  readonly learnedPath: string;
  readonly now?: () => number;
}

export function createProjectKeys(deps: ProjectKeysDeps): ProjectKeys {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; repo: Promise<{ root: string; remote: string } | null> }>();
  let learned: Record<string, string> = readLearned(deps.learnedPath);

  const repoOf = (path: string): Promise<{ root: string; remote: string } | null> => {
    const hit = cache.get(path);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.repo;
    const repo = (async () => {
      const dirs = existsSync(path) ? await deps.git.gitDirs(path) : null;
      if (!dirs) return null;
      const url = await deps.git.remoteUrl(dirs.toplevel);
      const remote = url ? normalizeRemote(url) : null;
      return remote ? { root: dirs.toplevel, remote } : null;
    })();
    cache.set(path, { at: now(), repo });
    return repo;
  };

  const find = async (key: string, folders: readonly string[]): Promise<string | null> => {
    const [remote, sub] = key.slice("git:".length).split("#", 2) as [string, string | undefined];
    for (const folder of new Set(folders)) {
      const repo = await repoOf(folder);
      if (repo?.remote === remote) return sub ? join(repo.root, sub) : repo.root;
    }
    return null;
  };

  const learn = (path: string, key: string): void => {
    if (learned[path] === key) return;
    learned = { ...learned, [path]: key };
    writeFileAtomic(deps.learnedPath, JSON.stringify(learned, null, 2));
  };

  return {
    async toKey(path) {
      const repo = await repoOf(path);
      if (!repo) return learned[path] ?? `path:${path}`;
      const sub = relative(realpath(repo.root), realpath(path));
      return `git:${repo.remote}${sub && !sub.startsWith("..") ? `#${sub}` : ""}`;
    },

    async toPath(key, hint) {
      if (key.startsWith("path:")) return key.slice("path:".length);
      const found = await find(key, [hint, ...deps.candidates()]);
      if (found) return found;
      learn(hint, key);
      return hint;
    },

    findPath(key) {
      return key.startsWith("git:") ? find(key, deps.candidates()) : Promise.resolve(null);
    },
  };
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function readLearned(path: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}
