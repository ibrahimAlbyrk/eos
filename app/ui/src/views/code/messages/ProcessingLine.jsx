// Inline activity indicator anchored under the latest message.
//   • busy=true  → accent breathing dot + "working" + live elapsed
//   • busy=false → static muted dot, no text (silent anchor under the reply)
export function ProcessingLine({ busy, elapsed }) {
  return (
    <div className={"activity-line" + (busy ? " is-busy" : "")}>
      <span className="al-dot" aria-hidden></span>
      {busy && (
        <span>
          working
          {elapsed && <> · <span className="mono">{elapsed}</span></>}
        </span>
      )}
    </div>
  );
}
