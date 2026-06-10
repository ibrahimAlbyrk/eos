import { segment, URL_RE } from "../../../lib/richText.jsx";
import { AgentLink } from "./AgentLink.jsx";

const LINK_RULES = [
  {
    match: URL_RE,
    render: (url, key) => (
      <a key={key} className="msg-link" href={url} rel="noreferrer">{url}</a>
    ),
  },
];

// The prompt is plain text shown verbatim — a markdown/HTML pipeline here
// mangles literal <tags> the orchestrator wrote (see lib/markdown.js).
export function MessageTask({ prompt, parentId, parentName, workers }) {
  return (
    <div className="msg-task">
      <div className="msg-task-header">
        <svg className="msg-task-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2h8l2 2v10H2V2h2z" />
          <path d="M5 6h6M5 9h4" />
        </svg>
        <span className="msg-task-label">Task from <b><AgentLink id={parentId} name={parentName} workers={workers} className="" /></b></span>
      </div>
      <div className="msg-task-body">{segment(String(prompt || ""), LINK_RULES)}</div>
    </div>
  );
}
