// The Eos dawn-star used as the transcript's activity mark. How it looks per
// state (turning while busy, small grey star when idle) is all CSS, keyed off
// the parent .activity-line — see transcript.css.
const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

export function ActivityStar() {
  return (
    <svg className="al-star" viewBox="-100 -100 200 200" width="14" height="14" aria-hidden="true">
      <g className="al-spin">
        <g className="al-rays">
          {RAY_ANGLES.map((deg) => (
            <g key={deg} transform={`rotate(${deg})`}>
              <rect className="al-ray" x="-13" y="-96" width="26" height="78" rx="13" />
              <rect className="al-ray-hi" x="-7" y="-64" width="14" height="44" rx="7" />
            </g>
          ))}
        </g>
      </g>
      <circle className="al-core" r="20" />
    </svg>
  );
}
