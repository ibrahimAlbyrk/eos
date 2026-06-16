// FileSystem port — generic project file operations for the Files explorer.
// Pure interface: the infra adapter (NodeFileSystem) owns all node:fs calls.
// Paths handed to these methods are already absolute and sandbox-validated by
// the route layer (resolveWithinRoot) — the port itself is root-agnostic so it
// stays a single-responsibility I/O abstraction.

export type FsEntryType = "file" | "directory";

// One directory child. Listing is stat-free for speed (type comes from the
// readdir Dirent), so size/mtime are NOT here — use stat() for that. Symlinks
// get a single follow to resolve whether the target is a dir (so the tree can
// show a chevron); a broken link falls back to type "file".
export interface FsEntryMeta {
  name: string;
  absolutePath: string;
  relativePath: string; // relative to the list root, "/"-joined
  type: FsEntryType;
  isSymlink: boolean;
}

export interface FsStat {
  absolutePath: string;
  type: FsEntryType;
  size: number; // bytes; directories report 0
  mtimeMs: number;
  isSymlink: boolean;
  readonly: boolean; // the daemon process lacks write access
}

export interface ListDirOptions {
  root: string; // for relativePath computation only
  includeHidden?: boolean; // default false (dotfiles)
  applyIgnore?: boolean; // default true (the IGNORED set: node_modules, .git, …)
}

export interface MoveOptions {
  overwrite?: boolean; // default false → collision throws ConflictError
}

export interface FileSystem {
  listDir(dir: string, opts: ListDirOptions): Promise<FsEntryMeta[]>;
  stat(path: string): Promise<FsStat>;
  createFile(path: string, content?: string): Promise<void>; // O_EXCL — collision → ConflictError
  mkdir(path: string): Promise<void>; // non-recursive leaf — missing parent → NotFoundError
  rename(from: string, to: string): Promise<void>; // collision → ConflictError
  move(from: string, to: string, opts?: MoveOptions): Promise<void>;
  trash(path: string): Promise<void>; // reversible delete (OS Trash / ~/.eos-trash)
  exists(path: string): Promise<boolean>;
}
