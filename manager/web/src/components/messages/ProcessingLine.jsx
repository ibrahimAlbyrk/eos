// Inline activity indicator anchored under the latest message.
//   • busy=true  → animated spark + live elapsed (how long the agent has
//                  been thinking since the user's last message)
//   • busy=false → static spark, no text (silent anchor under the reply)
export function ProcessingLine({ busy, elapsed }) {
  return (
    <div className={"thinking-line" + (busy ? "" : " thinking-line--static")}>
      <span className="spark"></span>
      {busy && elapsed && (
        <>
          <span className="thinking-sep" aria-hidden="true">·</span>
          <span className="mono">{elapsed}</span>
        </>
      )}
    </div>
  );
}
