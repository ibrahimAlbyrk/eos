// Inline "thinking · 7s · ..." line rendered as part of the assistant's
// turn. No icon — the activity anchor under the latest message already
// signals motion; an extra icon here is visual noise.
export function ThinkingLine({ text, ms }) {
  return (
    <div className="thinking-line">
      <span className="mono">
        thinking{ms ? ` · ${Math.round(ms / 1000)}s` : ""}{text ? ` · ${text.slice(0, 80)}` : ""}
      </span>
    </div>
  );
}
