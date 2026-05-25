import { useState } from "react";
import { useUi } from "../../state/ui.jsx";

export function ToolDetail({ tool }) {
  const name = tool.name ?? "";
  if (name === "Read") return <ReadDetail tool={tool} />;
  if (name === "Edit") return <EditDetail tool={tool} />;
  if (name === "Bash") return <BashDetail tool={tool} />;
  if (isMessagingTool(name)) return <MessageDetail tool={tool} />;
  return <GenericDetail tool={tool} />;
}

function isMessagingTool(name) {
  return name === "mcp__worker__send_message_to_parent"
    || name === "mcp__orchestrator__message_worker";
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

function EditDetail({ tool }) {
  const filePath = tool.input?.file_path ?? "";
  const oldStr = tool.input?.old_string ?? "";
  const newStr = tool.input?.new_string ?? "";
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  const hunks = buildDiffHunks(oldLines, newLines);

  return (
    <div className="tool-detail edit-detail">
      <div className="edit-filepath">{filePath}</div>
      <div className="edit-diff">
        {hunks.map((h, i) => (
          <div className={`ed-line ed-${h.type}`} key={i}>
            <span className="ed-num">{h.num ?? ""}</span>
            <span className="ed-sign">{h.type === "del" ? "-" : h.type === "add" ? "+" : " "}</span>
            <span className="ed-text">{h.segments ?? h.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildDiffHunks(oldLines, newLines) {
  const hunks = [];
  const maxCtx = Math.max(oldLines.length, newLines.length);
  if (maxCtx === 0) return hunks;

  const lcs = computeLCS(oldLines, newLines);
  let oi = 0, ni = 0, li = 0;
  let lineNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length
        && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      hunks.push({ type: "ctx", num: lineNum, text: lcs[li] });
      oi++; ni++; li++; lineNum++;
    } else {
      const delStart = hunks.length;
      while (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        hunks.push({ type: "del", num: oi + 1, text: oldLines[oi] });
        oi++;
      }
      const addStart = hunks.length;
      while (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        hunks.push({ type: "add", num: ni + 1, text: newLines[ni] });
        ni++; lineNum++;
      }
      const delCount = addStart - delStart;
      const addCount = hunks.length - addStart;
      const pairCount = Math.min(delCount, addCount);
      for (let p = 0; p < pairCount; p++) {
        const dh = hunks[delStart + p];
        const ah = hunks[addStart + p];
        const [dSegs, aSegs] = inlineDiff(dh.text, ah.text);
        dh.segments = dSegs;
        ah.segments = aSegs;
      }
    }
  }
  return hunks;
}

function computeLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.push(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return result.reverse();
}

function inlineDiff(oldText, newText) {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
  let suffixO = oldText.length, suffixN = newText.length;
  while (suffixO > prefix && suffixN > prefix && oldText[suffixO - 1] === newText[suffixN - 1]) { suffixO--; suffixN--; }

  const common1 = oldText.slice(0, prefix);
  const delPart = oldText.slice(prefix, suffixO);
  const addPart = newText.slice(prefix, suffixN);
  const common2 = oldText.slice(suffixO);

  const delSegs = (
    <>
      {common1}
      {delPart && <span className="ed-hl-del">{delPart}</span>}
      {common2}
    </>
  );
  const addSegs = (
    <>
      {common1}
      {addPart && <span className="ed-hl-add">{addPart}</span>}
      {common2}
    </>
  );
  return [delSegs, addSegs];
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

function MessageDetail({ tool }) {
  const text = tool.input?.text ?? "";
  return (
    <div className="report-detail" style={{ marginLeft: 0 }}>
      <div className="report-detail-text">{text}</div>
    </div>
  );
}

function highlightLine(line) {
  if (/^#{1,6}\s/.test(line)) {
    return <span className="hl-heading">{line}</span>;
  }
  return line;
}
