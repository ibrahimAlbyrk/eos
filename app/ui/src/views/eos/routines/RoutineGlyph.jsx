// A few glyphs by the routine's icon word; any other shows its first letter.
const GLYPHS = {
  eye: "M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
  branch: "M4.5 2.5v11M4.5 9.5c0-3 7-1.5 7-5M11.5 4.5v0",
  mail: "M2.5 4.5h11v7h-11zM2.5 5L8 9l5.5-4",
  paper: "M3 3.5h8v9H4a1 1 0 0 1-1-1zM11 6h2v5.5a1 1 0 0 1-1 1M5 6h4M5 8.3h4M5 10.5h2.5",
  pulse: "M2 8.5h2.8l1.6-4 3 7.5 1.6-3.5H14",
  calendar: "M3 4.5h10V13H3zM3 7h10M5.5 3v2.5M10.5 3v2.5",
  notes: "M3.5 4.5h9M3.5 8h9M3.5 11.5h5",
};

// `part` names the classes it is drawn with: `<part>__glyph`, `<part>__letter`.
export function RoutineGlyph({ icon, name, size, part }) {
  const d = GLYPHS[icon];
  if (!d) return <span className={`${part}__letter`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className={`${part}__glyph`}><path d={d} /></svg>;
}
