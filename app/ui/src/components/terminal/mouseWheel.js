// Wheel → mouse reports for TUIs that track the mouse (Claude Code runs in the
// alt screen with SGR mouse mode, so the wheel scrolls ITS viewport, not
// xterm's). xterm.js damps trackpad deltas by 0.3 and sends ONE report per wheel
// event whatever the distance, so scrolling Claude crawls. Like Ghostty, send
// one report per cell height of travel instead.

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
// Reports per line of travel. Claude Code layers its own acceleration on top of
// xterm.js wheel input, so a full 1:1 rate overshoots — tune by feel here.
const WHEEL_SPEED = 0.5;

// → (wheelEvent, cellHeightPx, rows) => signed whole steps; the sub-line
// remainder carries over so slow trackpad drags still add up.
export function createWheelAccumulator(speed = WHEEL_SPEED) {
  let partial = 0;
  return (e, cellHeight, rows) => {
    const lines = speed * (e.deltaMode === DOM_DELTA_LINE ? e.deltaY
      : e.deltaMode === DOM_DELTA_PAGE ? e.deltaY * rows
        : e.deltaY / cellHeight);
    if (Math.sign(lines) !== Math.sign(partial)) partial = 0; // direction flip
    partial += lines;
    const steps = Math.trunc(partial) || 0; // no -0
    partial -= steps;
    return steps;
  };
}

// SGR (DECSET 1006) wheel press: button 64 = up, 65 = down; col/row 1-based.
export function sgrWheelReports(steps, col, row) {
  return `\x1b[<${steps < 0 ? 64 : 65};${col};${row}M`.repeat(Math.abs(steps));
}
