import { useMemo, useState } from "react";
import { buildFileTree } from "./buildFileTree.js";

// File-tree sidebar: compressed dir chains with aggregate counts, file rows
// with per-file counts. Selecting a file tells the viewer, which expands and
// scrolls its card. Dir collapse state is local — it's pure navigation.
export function GitDiffTree({ files, selectedPath, onSelect }) {
  const tree = useMemo(() => buildFileTree(files ?? []), [files]);
  const [closedDirs, setClosedDirs] = useState(() => new Set());

  const toggleDir = (path) => {
    setClosedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <div className="gd-tree">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          closedDirs={closedDirs}
          onToggleDir={toggleDir}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function Counts({ ins, del, hasBinary }) {
  return (
    <span className="gd-tree-counts">
      {ins !== null && ins > 0 && <span className="dv-add">+{ins}</span>}
      {del !== null && del > 0 && <span className="dv-del">−{del}</span>}
      {(ins === null || hasBinary) && <span className="dv-bin">bin</span>}
    </span>
  );
}

function TreeNode({ node, depth, closedDirs, onToggleDir, selectedPath, onSelect }) {
  const pad = { paddingLeft: 10 + depth * 12 };
  if (node.type === "file") {
    return (
      <button
        className={"gd-tree-row" + (node.path === selectedPath ? " sel" : "")}
        style={pad}
        title={node.path}
        onClick={() => onSelect(node.path)}
      >
        <span className="gd-tree-label">{node.label}</span>
        <Counts ins={node.ins} del={node.del} />
      </button>
    );
  }
  const open = !closedDirs.has(node.path);
  return (
    <>
      <button className="gd-tree-row" style={pad} title={node.path} onClick={() => onToggleDir(node.path)}>
        <svg className={"gd-tree-chev" + (open ? " open" : "")} width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <svg className="gd-tree-folder" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
        </svg>
        <span className="gd-tree-label gd-tree-dir">{node.label}</span>
        <Counts ins={node.ins} del={node.del} hasBinary={node.hasBinary} />
      </button>
      {open && node.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          closedDirs={closedDirs}
          onToggleDir={onToggleDir}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
