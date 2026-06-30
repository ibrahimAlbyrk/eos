// ToolFileSystem — the DIP seam the built-in filesystem tools (Read/Write/Edit/
// MultiEdit/Glob/LS/NotebookEdit) depend on, so they unit-test against a fake with
// no disk. Distinct from the Files-explorer `FileSystem` port (which has no content
// read/write surface): this one is the minimal content+listing API the tools need.
// The Node adapter (infra/src/tools/NodeToolFileSystem) owns all node:fs calls.

export interface ToolFsStat {
  type: "file" | "directory";
  size: number; // bytes; directories report 0
  mtimeMs: number;
}

export interface ToolDirEntry {
  name: string;
  type: "file" | "directory";
}

export interface ToolFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ToolFsStat>;
  readDir(path: string): Promise<ToolDirEntry[]>;
  /** mkdir -p — Write/MultiEdit create missing parent directories. */
  ensureDir(path: string): Promise<void>;
}
