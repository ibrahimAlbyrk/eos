// NodeToolFileSystem — the node:fs adapter for the built-in tools' ToolFileSystem
// port. The only place the filesystem built-ins touch disk; tests inject a fake.

import { promises as fs } from "node:fs";
import type { ToolFileSystem, ToolFsStat, ToolDirEntry } from "../../../core/src/ports/ToolFileSystem.ts";

export function createNodeToolFileSystem(): ToolFileSystem {
  return {
    async readFile(path) {
      return fs.readFile(path, "utf8");
    },
    async writeFile(path, content) {
      await fs.writeFile(path, content, "utf8");
    },
    async exists(path) {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path): Promise<ToolFsStat> {
      const s = await fs.stat(path);
      return { type: s.isDirectory() ? "directory" : "file", size: s.isDirectory() ? 0 : s.size, mtimeMs: s.mtimeMs };
    },
    async readDir(path): Promise<ToolDirEntry[]> {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    },
    async ensureDir(path) {
      await fs.mkdir(path, { recursive: true });
    },
  };
}
