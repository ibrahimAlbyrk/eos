import { memo, useMemo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { ToolShell, PathLine, Chips } from "./ToolShell.jsx";
import { resultStatus, splitPath, langFromPath, lineCount } from "./shared.js";

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

export const ReadTool = memo(function ReadTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const path = tool.input?.file_path || tool.input?.notebook_path || "";
  const lang = langFromPath(path);
  const offset = tool.input?.offset;
  const limit = tool.input?.limit;
  const rawBody = (result?.body || "").trim();
  const body = useMemo(() => stripCatN(rawBody), [rawBody]);
  const numLines = useMemo(() => lineCount(body), [body]);
  const previewLines = useMemo(() => {
    if (!body) return [];
    const all = body.split("\n");
    return all.slice(0, 14);
  }, [body]);
  const startLine = offset || 1;

  const subtitle = (
    <span className="vb-tool__sub-grp">
      {limit ? <span>lines {startLine}–{startLine + Math.min(limit, numLines) - 1}</span>
            : <span>{numLines || "—"} lines</span>}
      {lang && <><span className="vb-tool__sub-sep">·</span><span>{lang}</span></>}
    </span>
  );

  const innerBody = body ? (
    <div className="vb-toolbody vb-toolbody--read">
      <div className="vb-readpane">
        <pre className="vb-readpane__pre">
{previewLines.map((line, i) => (
  <div key={i} className="vb-readpane__row">
    <span className="vb-readpane__num">{startLine + i}</span>
    <span className="vb-readpane__txt">{renderCode(line, lang)}</span>
  </div>
))}
{numLines > previewLines.length && (
  <div className="vb-readpane__more">… {numLines - previewLines.length} more lines</div>
)}
        </pre>
      </div>
    </div>
  ) : null;

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
