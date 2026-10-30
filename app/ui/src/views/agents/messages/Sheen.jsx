// The running sweep, drawn without repainting the text. Its host
// (`.ti-sheen-host`) paints its text once in the dim base tone; this
// aria-hidden copy in the bright tone slides under a moving masked window, the
// two moving in opposite directions so the copy stays put — both transform
// animations, so they run on the compositor. A background-position sweep
// repaints the text every frame, which keeps the renderer's main thread
// running a full frame at the display rate while anything runs.
// Pass the same content the host shows; the copy takes no pointer events and
// is hidden from assistive tech.
export function Sheen({ children }) {
  return (
    <span className="ti-sheen" aria-hidden="true">
      <span className="ti-sheen__copy">{children}</span>
    </span>
  );
}
