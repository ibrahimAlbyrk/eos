import { useBallRoll } from "../../../hooks/useBallRoll.js";

// Send / stop affordance for the composer. Presentational only: the composer
// owns the decision (which mode) and the wiring (what each click does); this
// renders the ball — arrow on its front, stop square on its back — which rolls
// forward half a turn whenever the mode flips (lib/ballRoll.js). Callers key it
// by agent, so switching agents snaps to that agent's face instead of rolling.
export function SubmitButton({ stop, dim, onClick }) {
  const { buttonRef, canvasRef } = useBallRoll(stop);
  return (
    <button
      ref={buttonRef}
      className={"submit" + (stop ? " stop" : "") + (dim ? " dim" : "")}
      title={stop ? "Stop (Esc)" : "Send"}
      onClick={onClick}
    >
      <canvas ref={canvasRef} className="ball-decal" aria-hidden="true" />
      <span className="ball-gloss" aria-hidden="true" />
    </button>
  );
}
