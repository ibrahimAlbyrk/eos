import { useState, useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { buildDiffHunks, parseAskAnswers, stripCatLineNumbers } from "../../../lib/diff.jsx";

export function ToolDetail({ tool, cwd }) {
  const name = tool.name ?? "";
  if (name === "Read") return <ReadDetail tool={tool} />;
  if (name === "Edit") return <EditDetail tool={tool} />;
  if (name === "Write") return <WriteDetail tool={tool} />;
  if (name === "Bash") return <BashDetail tool={tool} />;
  if (name === "AskUserQuestion") return <AskUserQuestionDetail tool={tool} />;
  if (name === "Skill") return <SkillDetail tool={tool} cwd={cwd} />;
  if (name === "mcp__orchestrator__notify_user") return <NotifyDetail tool={tool} />;
  if (name === "mcp__worker__send_message_to_parent") return <MessageDetail tool={tool} />;
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
  const isDenied = isError && /^denied|permission mode|denied by policy/i.test(output);

  return (
    <div className="tool-detail bash-detail">
      <FailureBanner tool={tool} />
      <div className="bash-label">Bash</div>
      <div className="bash-cmd">
        <span className="bash-prompt">$</span>
        <span className="bash-cmd-text">{cmd}</span>
      </div>
      {!isDenied && (
        <div className={"bash-output" + (isError ? " error" : "")}>
          {output ? output.slice(0, 4000) : "(Bash completed with no output)"}
        </div>
      )}
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
      <FailureBanner tool={tool} />
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

function FailureBanner({ tool }) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  const isDenied = /^denied|permission mode|denied by policy/i.test(text);
  return (
    <div className={"tool-failure-banner" + (isDenied ? " denied" : "")}>
      <span className="tfb-label">{isDenied ? "Denied" : "Failed"}</span>
      <span className="tfb-msg">{text || (isDenied ? "Permission denied" : "Tool call failed")}</span>
    </div>
  );
}

function WriteDetail({ tool }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  const filePath = tool.input?.file_path ?? "";
  const content = tool.input?.content ?? "";
  const lines = content.split("\n").map((t, i) => ({ num: i + 1, text: t }));
  const hasMore = lines.length > 5;
  const preview = lines.slice(0, 5);

  const copyContent = () => {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const openInViewer = () => {
    if (filePath) ui.openFileViewer(filePath);
  };

  return (
    <div className="tool-detail read-detail">
      <FailureBanner tool={tool} />
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
              <span className="cp-text">({lines.length - 5} more lines)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AskUserQuestionDetail({ tool }) {
  const questions = tool.input?.questions ?? [];
  const answers = parseAskAnswers(questions, tool.result?.text);

  return (
    <div className="tool-detail tool-qa">
      {questions.map((q, i) => (
        <div className="tool-qa-item" key={i}>
          <div className="tool-qa-q">{q.question ?? q.text ?? q}</div>
          <div className="tool-qa-a">
            {answers[i] != null ? <><span className="tool-qa-arrow">→</span> {answers[i]}</> : <span className="tool-qa-pending">Waiting...</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? text.slice(m[0].length) : text).replace(/^\s*\n+/, "");
}

function SkillDetail({ tool, cwd }) {
  const ui = useUi();
  const skill = tool.input?.skill ?? "skill";
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState({ loading: true, content: "", path: "", error: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, content: "", path: "", error: null });
    api.readSkill(skill, cwd)
      .then((r) => { if (alive) setState({ loading: false, content: r.content ?? "", path: r.path ?? "", error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, content: "", path: "", error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [skill, cwd]);

  const body = stripFrontmatter(state.content);
  const lines = body ? body.split("\n").map((t, i) => ({ num: i + 1, text: t })) : [];
  const hasMore = lines.length > 5;
  const preview = lines.slice(0, 5);

  const copyContent = () => {
    navigator.clipboard.writeText(body).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="tool-detail read-detail">
      <div className="file-path-bar" onClick={() => state.path && ui.openFileViewer(state.path)}>
        <span className={"fp-path" + (state.path ? " ti-link" : "")}>{skill} skill</span>
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
      {(state.loading || state.error) && (
        <div className="code-preview">
          <div className="cp-line cp-fade">
            <span className="cp-num"></span>
            <span className="cp-text">{state.loading ? "Loading…" : state.error}</span>
          </div>
        </div>
      )}
      {!state.loading && !state.error && preview.length > 0 && (
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
              <span className="cp-text">({lines.length - 5} more lines)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotifyDetail({ tool }) {
  const title = tool.input?.title ?? "";
  const body = tool.input?.body ?? "";
  return (
    <div className="tool-detail notify-detail">
      <FailureBanner tool={tool} />
      <div className="nd-title">
        <svg className="nd-bell" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z" />
          <path d="M6.8 13.5a1.3 1.3 0 0 0 2.4 0" />
        </svg>
        {title}
      </div>
      {body && <div className="nd-body">{body}</div>}
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
