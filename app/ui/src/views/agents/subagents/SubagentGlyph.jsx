// A subagent's mark: one of the identity glyphs (lib/subagentIdentity.js), filled
// with its color. Running ones breathe; failed/stopped ones go grey.

const circle = (x, y, r, sweep = 0) =>
  `M${x - r} ${y}a${r} ${r} 0 1 ${sweep} ${2 * r} 0a${r} ${r} 0 1 ${sweep} ${-2 * r} 0Z`;

const GLYPH_PATHS = {
  quad: "M8 .4 11.2 3.6 8 6.8 4.8 3.6Z M12.4 4.8 15.6 8 12.4 11.2 9.2 8Z M8 9.2 11.2 12.4 8 15.6 4.8 12.4Z M3.6 4.8 6.8 8 3.6 11.2 .4 8Z",
  clover: circle(8, 4.7, 3.1) + circle(11.3, 8, 3.1) + circle(8, 11.3, 3.1) + circle(4.7, 8, 3.1),
  grid: [[3, 3, 1.35], [13, 3, 1.35], [3, 13, 1.35], [13, 13, 1.35], [8, 3, 1.6], [3, 8, 1.6], [13, 8, 1.6], [8, 13, 1.6], [8, 8, 2.1]]
    .map(([x, y, r]) => circle(x, y, r)).join(""),
  spark: "M8 .5C8.6 5.2 10.8 7.4 15.5 8 10.8 8.6 8.6 10.8 8 15.5 7.4 10.8 5.2 8.6 .5 8 5.2 7.4 7.4 5.2 8 .5Z",
  flower: circle(8, 8, 1.7) + [[8, 3], [12.33, 5.5], [12.33, 10.5], [8, 13], [3.67, 10.5], [3.67, 5.5]]
    .map(([x, y]) => circle(x, y, 1.9)).join(""),
  pinwheel: "M8 8V1.5A3.25 3.25 0 0 1 8 8Z M8 8H14.5A3.25 3.25 0 0 1 8 8Z M8 8V14.5A3.25 3.25 0 0 1 8 8Z M8 8H1.5A3.25 3.25 0 0 1 8 8Z",
  triad: "M8 1.2 11.6 7.4 4.4 7.4Z M4.2 8.6 7.8 14.8 .6 14.8Z M11.8 8.6 15.4 14.8 8.2 14.8Z",
  // the ring's inner circle winds the other way, so it cuts a hole
  orbit: circle(7, 9, 5) + circle(7, 9, 3.1, 1) + circle(13, 3, 2.1),
};

export function SubagentGlyph({ identity, status, size = 14 }) {
  const state = status === "running" ? " is-live" : status === "failed" || status === "stopped" ? " is-dim" : "";
  return (
    <svg
      className={"sa-glyph" + state}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ "--sa": identity.hex }}
      aria-hidden="true"
    >
      <path d={GLYPH_PATHS[identity.glyph]} fill="currentColor" />
    </svg>
  );
}
