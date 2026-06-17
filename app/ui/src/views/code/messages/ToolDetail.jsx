import { useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { buildDiffHunks, patchToHunks, parseAskAnswers, stripCatLineNumbers } from "../../../lib/diff.jsx";
import { skillFilePath } from "../../../lib/skillBody.js";

// Per-tool expanded detail components. Routing (tool name → Detail) and the
// header labels live in ./toolViews.jsx; this file only owns the bodies.

export function ReadDetail({ tool }) {
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
      {preview.length > 0 ? (
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
      ) : tool.running ? (
        <div className="code-preview">
          <div className="cp-line cp-fade">
            <span className="cp-num"></span>
            <span className="cp-text">Reading…</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BashDetail({ tool }) {
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
      {!isError && (
        <div className="bash-output">
          {output ? output.slice(0, 4000) : tool.running ? "Running…" : "(Bash completed with no output)"}
        </div>
      )}
      <FailureBanner tool={tool} />
    </div>
  );
}

export function EditDetail({ tool }) {
  const filePath = tool.input?.file_path ?? "";
  const patch = tool.result?.patch;
  // The tool_result's structuredPatch carries absolute file line numbers; the
  // input snippet does not. Fall back to the snippet (relative numbers) while
  // the edit is still running or for legacy/MCP edits with no patch.
  const oldStr = tool.input?.old_string ?? "";
  const newStr = tool.input?.new_string ?? "";
  const hunks = Array.isArray(patch) && patch.length > 0
    ? patchToHunks(patch)
    : buildDiffHunks(oldStr ? oldStr.split("\n") : [], newStr ? newStr.split("\n") : []);

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
      <span className="tfb-msg">{text || (isDenied ? "Permission denied" : "Tool call failed")}</span>
    </div>
  );
}

export function WriteDetail({ tool }) {
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

export function AskUserQuestionDetail({ tool }) {
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

// ask_user (orchestrator MCP) — input mirrors AskUserQuestion's shape, but the
// result is the tool's own JSON ({answers: {question: label}}) or, when the
// operator dismissed / the question went stale, a plain sentence.
export function AskUserDetail({ tool }) {
  const questions = tool.input?.questions ?? [];
  const text = tool.result?.text ?? "";
  let answers = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.answers) answers = parsed.answers;
  } catch { /* non-JSON result (dismissed / gone) rendered below the questions */ }

  return (
    <div className="tool-detail tool-qa">
      {questions.map((q, i) => {
        const a = answers ? answers[q.question] ?? answers[q.header] : null;
        return (
          <div className="tool-qa-item" key={i}>
            <div className="tool-qa-q">{q.question}</div>
            <div className="tool-qa-a">
              {a != null
                ? <><span className="tool-qa-arrow">→</span> {a}</>
                : !text && <span className="tool-qa-pending">Waiting...</span>}
            </div>
          </div>
        );
      })}
      {!answers && text && (
        <div className="tool-qa-a"><span className="tool-qa-pending">{text}</span></div>
      )}
    </div>
  );
}

export function SkillDetail({ tool }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);

  const body = tool.skillBody ?? "";
  // skillPath is the skill's base directory, parsed out of the injected body
  // (lib/skillBody.js); pathless skills (built-ins) get no header bar at all.
  const skillFile = skillFilePath(tool.skillPath);
  const lines = body ? body.split("\n").map((t, i) => ({ num: i + 1, text: t })) : [];
  const hasMore = lines.length > 5;
  const preview = lines.slice(0, 5);

  // No injected SKILL.md body available (the claude-sdk lane surfaces only the
  // "Launching skill: <name>" tool result — the body is injected server-side and
  // never reaches the stream). Fall back to the generic result/params view so
  // expanding shows the launch result instead of rendering nothing.
  if (!body && !skillFile) return <GenericDetail tool={tool} />;

  const copyContent = () => {
    navigator.clipboard.writeText(body).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const openInViewer = () => {
    if (skillFile) ui.openFileViewer(skillFile);
  };

  const copyBtn = body ? (
    <button className={"fp-copy" + (skillFile ? "" : " fp-copy-float")} onClick={(e) => { e.stopPropagation(); copyContent(); }} title="Copy content">
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
  ) : null;

  return (
    <div className="tool-detail read-detail">
      {skillFile ? (
        <div className="file-path-bar" onClick={openInViewer}>
          <span className="fp-path">{skillFile.replace(/^\/Users\/[^/]+/, "~")}</span>
          {copyBtn}
        </div>
      ) : copyBtn}
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

export function NotifyDetail({ tool }) {
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

const GENERIC_OUTPUT_MAX = 4000;

// Fallback detail for tools without a bespoke renderer (mostly custom MCP
// tools). One card holds the parameters (top) and the tool's result (below).
// When there is no result yet (running, or a tool that never returns output)
// only the parameters block shows.
export function GenericDetail({ tool }) {
  const params = Object.entries(tool.input ?? {}).filter(([, v]) => v !== undefined && v !== null);
  const result = tool.result;
  const output = (result?.text ?? "").trim();
  const hasOutput = result != null && !result.isError && output !== "";
  const hasCard = params.length > 0 || hasOutput;

  if (!hasCard && !result?.isError) return null;

  return (
    <div className="tool-detail generic-detail">
      {result?.isError && <FailureBanner tool={tool} />}
      {hasCard && (
        <div className="gd-card">
          {params.length > 0 && (
            <div className="gd-block">
              <div className="gd-section">Parameters</div>
              {params.map(([key, val]) => (
                <div className="gd-row" key={key}>
                  <span className="gd-key">{key}:</span>{" "}
                  <span className="gd-val">{typeof val === "object" ? JSON.stringify(val) : String(val)}</span>
                </div>
              ))}
            </div>
          )}
          {hasOutput && (
            <div className="gd-block">
              <div className="gd-section">Output</div>
              <div className="gd-output-text">{output.slice(0, GENERIC_OUTPUT_MAX)}</div>
              {output.length > GENERIC_OUTPUT_MAX && (
                <div className="gd-output-more">+{output.length - GENERIC_OUTPUT_MAX} more characters</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageDetail({ tool }) {
  const text = tool.input?.text ?? "";
  return (
    <div className="report-detail" style={{ marginLeft: 0 }}>
      <div className="report-detail-text">{text}</div>
    </div>
  );
}

// ask_peer (worker MCP) — a consultation: the question asked + the peer's
// answer (the tool result). Same Q→A chrome as ask_user.
export function PeerAskDetail({ tool }) {
  if (tool.result?.isError) {
    return <div className="tool-detail generic-detail"><FailureBanner tool={tool} /></div>;
  }
  const question = tool.input?.question ?? "";
  const answer = (tool.result?.text ?? "").trim();
  return (
    <div className="tool-detail tool-qa">
      <div className="tool-qa-item">
        <div className="tool-qa-q">{question}</div>
        <div className="tool-qa-a">
          {answer
            ? <><span className="tool-qa-arrow">→</span> {answer}</>
            : <span className="tool-qa-pending">Waiting…</span>}
        </div>
      </div>
    </div>
  );
}

// respond_to_peer (worker MCP) — the answer this worker gave a peer, in the
// same report-detail body as send_message_to_parent.
export function PeerRespondDetail({ tool }) {
  const answer = tool.input?.answer ?? "";
  return (
    <div className="report-detail" style={{ marginLeft: 0 }}>
      <div className="report-detail-text">{answer}</div>
    </div>
  );
}

// list_peers (worker MCP) — the consultable peer roster (name · state, with the
// specialty summary), same plain-text rows as the worker-management tools.
export function PeerListDetail({ tool }) {
  if (tool.result?.isError) {
    return <div className="tool-detail generic-detail"><FailureBanner tool={tool} /></div>;
  }
  let peers = null;
  try {
    const parsed = JSON.parse(tool.result?.text ?? "");
    if (Array.isArray(parsed)) peers = parsed;
  } catch { /* running or non-JSON — nothing to show yet */ }
  if (!peers) return null;
  const body = peers.length === 0
    ? "No peers available."
    : peers
        .map((p) => {
          const head = [p.name, p.state].filter(Boolean).join(" · ");
          return p.summary ? `${head}\n${p.summary}` : head;
        })
        .join("\n\n");
  return (
    <div className="report-detail" style={{ marginLeft: 0 }}>
      <div className="report-detail-text">{body}</div>
    </div>
  );
}

function highlightLine(line) {
  if (/^#{1,6}\s/.test(line)) {
    return <span className="hl-heading">{line}</span>;
  }
  return line;
}
