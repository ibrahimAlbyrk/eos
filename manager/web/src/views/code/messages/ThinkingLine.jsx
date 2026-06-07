// Inline "thinking · ..." line rendered as part of the assistant's turn.
// No icon — the activity anchor under the latest message already signals
// motion; an extra icon here is visual noise.
export function ThinkingLine({ text }) {
  return (
    <div className="thinking-line">
      <span className="mono">
        thinking{text ? ` · ${text}` : ""}
      </span>
    </div>
  );
}
