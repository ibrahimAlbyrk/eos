export function MessageTask({ prompt, parentName }) {
  return (
    <div className="msg-task">
      <div className="msg-task-header">
        <svg className="msg-task-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2h8l2 2v10H2V2h2z" />
          <path d="M5 6h6M5 9h4" />
        </svg>
        <span className="msg-task-label">Task from <b>{parentName}</b></span>
      </div>
      <div className="msg-task-body">{prompt}</div>
    </div>
  );
}
