export function ThinkingLine({ text, ms }) {
  return (
    <div className="thinking-line">
      <span className="spark"></span>
      <span className="mono">
        thinking{ms ? ` · ${Math.round(ms / 1000)}s` : ""}{text ? ` · ${text.slice(0, 80)}` : ""}
      </span>
    </div>
  );
}
