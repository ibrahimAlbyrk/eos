import { memo, useMemo, useState } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { ToolShell, PathLine } from "./ToolShell.jsx";
import { resultStatus, langFromPath, lineCount } from "./shared.js";

// Strip Claude's "cat -n" output prefix (`     1\t...`). Keeps the rendered
// content as plain text the line-number rail is responsible for.
function stripCatN(body) {
  if (!body) return "";
  const lines = body.split("\n");
  let stripped = 0;
  const out = lines.map(line => {
    const m = /^\s*(\d+)\t(.*)$/.exec(line);
    if (m) { stripped++; return m[2]; }
    return line;
  });
  return stripped > Math.max(1, lines.length * 0.4) ? out.join("\n") : body;
}

// Inline syntax highlight using highlight.js core registered languages. The
// markdown layer already registers everything we need; importing it here
// triggers the same registration via tree-shaken modules.
function renderCode(code, lang) {
  return code; // plaintext path — keeping pure-text path keeps the rail
               // numbering trivially aligned. Could expand to hljs later.
}

const PREVIEW_LINES = 14;

export const ReadTool = memo(function ReadTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const path = tool.input?.file_path || tool.input?.notebook_path || "";
  const lang = langFromPath(path);
  const offset = tool.input?.offset;
  const limit = tool.input?.limit;
  const isError = result?.type === "error";
  const rawBody = (result?.body || "").trim();
  const body = useMemo(() => (isError ? rawBody : stripCatN(rawBody)), [rawBody, isError]);
  const numLines = useMemo(() => lineCount(body), [body]);
  const [expanded, setExpanded] = useState(false);
  const allLines = useMemo(() => (body ? body.split("\n") : []), [body]);
  const previewLines = useMemo(
    () => (expanded ? allLines : allLines.slice(0, PREVIEW_LINES)),
    [allLines, expanded]
  );
  const startLine = offset || 1;

  const subtitle = (
    <span className="vb-tool__sub-grp">
      {numLines > 0 && limit
        ? <span>lines {startLine}–{startLine + Math.min(limit, numLines) - 1}</span>
        : <span>{numLines || "—"} lines</span>}
      {lang && <><span className="vb-tool__sub-sep">·</span><span>{lang}</span></>}
    </span>
  );

  let innerBody = null;
  if (isError && body) {
    innerBody = (
      <div className="vb-toolbody vb-toolbody--read vb-toolbody--error">
        <pre className="vb-code vb-code--error">{body}</pre>
      </div>
    );
  } else if (body) {
    const hidden = numLines - previewLines.length;
    innerBody = (
      <div className="vb-toolbody vb-toolbody--read">
        <div className="vb-readpane">
          <pre className="vb-readpane__pre">
            {previewLines.map((line, i) => (
              <div key={i} className="vb-readpane__row">
                <span className="vb-readpane__num">{startLine + i}</span>
                <span className="vb-readpane__txt">{line}</span>
              </div>
            ))}
          </pre>
          {(hidden > 0 || expanded) && (
            <button
              type="button"
              className="vb-readpane__more vb-readpane__more--toggle"
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            >
              {expanded ? "Show less" : `Show ${hidden} more lines`}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <ToolShell
      family={family}
      icon={base === "NotebookRead" ? "notebook" : "read"}
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">{base}</span>
          <span className="vb-tool__arr">›</span>
          <PathLine path={path} accent />
        </span>
      }
      subtitle={subtitle}
      status={resultStatus(result)}
      filePath={path}
      body={innerBody}
    />
  );
});
