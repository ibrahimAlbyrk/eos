import { memo, useMemo } from "react";
import { ToolShell, PathLine } from "./ToolShell.jsx";
import { resultStatus, splitPath, langFromPath, formatBytes, lineCount } from "./shared.js";

// "Write" emits a brand new (or rewritten) file. The content lives on the
// tool's `input.content`. We render it as an all-green numbered listing —
// every line is implicitly added, so the rail is unambiguously +.
export const WriteTool = memo(function WriteTool({ tool, result, family }) {
  const path = tool.input?.file_path || "";
  const content = String(tool.input?.content ?? "");
  const lang = langFromPath(path);
  const numLines = useMemo(() => lineCount(content), [content]);
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const previewLines = useMemo(() => content.split("\n").slice(0, 18), [content]);

  const subtitle = (
    <span className="vb-tool__sub-grp">
      <span>{numLines} lines</span>
      <span className="vb-tool__sub-sep">·</span>
      <span>{formatBytes(bytes)}</span>
      {lang && <><span className="vb-tool__sub-sep">·</span><span>{lang}</span></>}
    </span>
  );

  const body = content ? (
    <div className="vb-toolbody vb-toolbody--write">
      <div className="vb-writepane">
        <pre className="vb-writepane__pre">
{previewLines.map((line, i) => (
  <div key={i} className="vb-writepane__row">
    <span className="vb-writepane__sign">+</span>
    <span className="vb-writepane__num">{i + 1}</span>
    <span className="vb-writepane__txt">{line}</span>
  </div>
))}
{numLines > previewLines.length && (
  <div className="vb-writepane__more">… {numLines - previewLines.length} more lines</div>
)}
        </pre>
      </div>
    </div>
  ) : null;

  return (
    <ToolShell
      family={family}
      icon="filePlus"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">Write</span>
          <span className="vb-tool__arr">›</span>
          <PathLine path={path} accent />
        </span>
      }
      subtitle={subtitle}
      status={resultStatus(result)}
      filePath={path}
      defaultOpen={numLines <= 18}
      body={body}
    />
  );
});
