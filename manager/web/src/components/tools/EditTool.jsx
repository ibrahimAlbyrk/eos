import { memo, useMemo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { diffLinesUnified } from "../../lib/diff.js";
import { ToolShell, PathLine } from "./ToolShell.jsx";
import { DiffView } from "./DiffView.jsx";
import { resultStatus, splitPath, langFromPath } from "./shared.js";

function edits(input, toolName) {
  const base = stripMcpPrefix(toolName);
  if (base === "Edit") {
    return [{ old: input?.old_string ?? "", new: input?.new_string ?? "", replace_all: !!input?.replace_all }];
  }
  if (base === "MultiEdit") {
    const arr = Array.isArray(input?.edits) ? input.edits : [];
    return arr.map(e => ({ old: e?.old_string ?? "", new: e?.new_string ?? "", replace_all: !!e?.replace_all }));
  }
  if (base === "NotebookEdit") {
    return [{ old: input?.old_source ?? "", new: input?.new_source ?? "", replace_all: false, cellId: input?.cell_id, cellType: input?.cell_type, mode: input?.edit_mode }];
  }
  return [];
}

function pathOf(input, toolName) {
  const base = stripMcpPrefix(toolName);
  if (base === "NotebookEdit") return input?.notebook_path || "";
  return input?.file_path || "";
}

// Count actually-changed lines via the same line-diff the body renders,
// so the subtitle stat matches what the user sees inside DiffView.
function statsOf(eds) {
  let add = 0, del = 0;
  for (const e of eds) {
    const { stats } = diffLinesUnified(e.old || "", e.new || "");
    del += stats.del;
    add += stats.add;
  }
  return { add, del };
}

export const EditTool = memo(function EditTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const path = pathOf(tool.input, tool.tool);
  const { file } = splitPath(path);
  const lang = langFromPath(path);
  const eds = useMemo(() => edits(tool.input, tool.tool), [tool.input, tool.tool]);
  const stats = useMemo(() => statsOf(eds), [eds]);

  const titleNoun = base === "Edit" ? "Edit" : base === "MultiEdit" ? "MultiEdit" : "Notebook";
  const replacementWord = eds.length === 1 ? "replacement" : "replacements";

  const body = (
    <div className="vb-toolbody vb-toolbody--edit">
      {eds.map((e, i) => (
        <DiffView
          key={i}
          oldStr={e.old}
          newStr={e.new}
          language={lang}
          label={eds.length > 1 ? `${i + 1} of ${eds.length}${e.replace_all ? "  ·  replace all" : ""}` : (lang || null)}
        />
      ))}
    </div>
  );

  const subtitle = (
    <span className="vb-tool__sub-grp">
      <span>{eds.length} {replacementWord}</span>
      <span className="vb-tool__sub-sep">·</span>
      <span className="vb-tool__sub-del">−{stats.del}</span>
      <span className="vb-tool__sub-add">+{stats.add}</span>
      {base === "NotebookEdit" && eds[0]?.cellId && (
        <>
          <span className="vb-tool__sub-sep">·</span>
          <span className="vb-tool__sub-cell">cell {eds[0].cellId}</span>
        </>
      )}
    </span>
  );

  return (
    <ToolShell
      family={family}
      icon={base === "NotebookEdit" ? "notebook" : "diff"}
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">{titleNoun}</span>
          <span className="vb-tool__arr">›</span>
          <PathLine path={path || file} accent />
        </span>
      }
      subtitle={subtitle}
      status={resultStatus(result)}
      filePath={path}
      defaultOpen={stats.add + stats.del <= 24 && eds.length <= 3}
      body={body}
    />
  );
});
