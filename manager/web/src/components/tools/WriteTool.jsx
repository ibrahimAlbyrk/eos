import { memo, useMemo, useState } from "react";
import { ToolShell, PathLine } from "./ToolShell.jsx";
import { resultStatus, langFromPath, formatBytes, lineCount } from "./shared.js";

const PREVIEW_LINES = 18;

// "Write" emits a brand new (or rewritten) file. The content lives on the
// tool's `input.content`. We render it as an all-green numbered listing —
// every line is implicitly added, so the rail is unambiguously +.
export const WriteTool = memo(function WriteTool({ tool, result, family }) {
  const path = tool.input?.file_path || "";
  const content = String(tool.input?.content ?? "");
  const lang = langFromPath(path);
  const numLines = useMemo(() => lineCount(content), [content]);
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  // Strip a single trailing newline so split() doesn't produce a phantom
  // empty row for normal POSIX-formatted files.
  const normalized = useMemo(() => (content.endsWith("\n") ? content.slice(0, -1) : content), [content]);
  const allLines = useMemo(() => (normalized ? normalized.split("\n") : []), [normalized]);
  const [expanded, setExpanded] = useState(false);
  const previewLines = expanded ? allLines : allLines.slice(0, PREVIEW_LINES);
  const hidden = allLines.length - previewLines.length;

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
        </pre>
        {(hidden > 0 || expanded) && (
          <button
            type="button"
            className="vb-writepane__more vb-writepane__more--toggle"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          >
            {expanded ? "Show less" : `Show ${hidden} more lines`}
          </button>
        )}
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
      defaultOpen={numLines <= PREVIEW_LINES}
      body={body}
    />
  );
});
