import { useState } from "react";
import { useUi } from "../../state/ui.jsx";

export function ToolDetail({ tool }) {
  const name = tool.name ?? "";
  if (name === "Read") return <ReadDetail tool={tool} />;
  if (name === "Bash") return <BashDetail tool={tool} />;
  return <GenericDetail tool={tool} />;
}

function ReadDetail({ tool }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  const filePath = tool.input?.file_path ?? "";
  const raw = tool.result?.text ?? "";
  const parsed = stripCatLineNumbers(raw);
  const hasMore = parsed.length > 5;
  const preview = parsed.slice(0, 5);

  const copyContent = () => {
    navigator.clipboard.writeText(parsed.map((l) => l.text).join("\n")).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const openInViewer = () => {
    if (filePath) ui.openFileViewer(filePath);
  };

  return (
    <div className="tool-detail read-detail">
      <div className="file-path-bar" onClick={openInViewer}>
        <span className="fp-path">{filePath}</span>
        <button className="fp-copy" onClick={(e) => { e.stopPropagation(); copyContent(); }} title="Copy content">
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 8.5 3 3 7-7" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
            </svg>
          )}
        </button>
      </div>
      {preview.length > 0 && (
        <div className="code-preview">
          {preview.map((l, i) => (
            <div className="cp-line" key={i}>
              <span className="cp-num">{l.num}</span>
              <span className="cp-text">{highlightLine(l.text)}</span>
            </div>
          ))}
          {hasMore && (
            <div className="cp-line cp-fade">
              <span className="cp-num"></span>
              <span className="cp-text">({parsed.length - 5} more lines)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BashDetail({ tool }) {
  const cmd = tool.input?.command ?? "";
  const output = tool.result?.text ?? "";
  const isError = tool.result?.isError ?? false;

  return (
    <div className="tool-detail bash-detail">
      <div className="bash-label">Bash</div>
      <div className="bash-cmd">
        <span className="bash-prompt">$</span>
        <span className="bash-cmd-text">{cmd}</span>
      </div>
      <div className={"bash-output" + (isError ? " error" : "")}>
        {output ? output.slice(0, 4000) : "(Bash completed with no output)"}
      </div>
    </div>
  );
}

function GenericDetail({ tool }) {
  const entries = Object.entries(tool.input ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && typeof v !== "object"
  );
  if (entries.length === 0) return null;

  return (
    <div className="tool-detail generic-detail">
      {entries.map(([key, val]) => (
        <div className="gd-row" key={key}>
          <span className="gd-key">{key}:</span>{" "}
          <span className="gd-val">{String(val)}</span>
        </div>
      ))}
    </div>
  );
}

function stripCatLineNumbers(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const hasCatNums = lines.length > 1 && /^\s*\d+\t/.test(lines[0]);
  if (!hasCatNums) return lines.map((t, i) => ({ num: i + 1, text: t }));
  return lines.map((line) => {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    return m ? { num: parseInt(m[1], 10), text: m[2] } : { num: 0, text: line };
  });
}

function highlightLine(line) {
  if (/^#{1,6}\s/.test(line)) {
    return <span className="hl-heading">{line}</span>;
  }
  return line;
}
