const GLYPH = {
  folder: "M2.5 5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  image: "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5",
  text: "M3.5 4.5h9M3.5 8h9M3.5 11.5h5",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
};

// The things before the text (RunIntent.dc.html): each a chip with its glyph,
// its name and a remove button; an upload in progress says so.
export function ThingChips({ things, onRemove }) {
  if (things.length === 0) return null;
  return (
    <ul className="eos-things" aria-label="Added">
      {things.map((t) => (
        <li key={t.id} className={t.status === "uploading" ? "eos-thing eos-thing--uploading" : "eos-thing"}>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" className="eos-thing__glyph">
            <path d={GLYPH[t.kind] ?? GLYPH.file} />
          </svg>
          <span className="eos-thing__label">{t.label}</span>
          {t.status === "uploading" && <span className="eos-sr"> (adding)</span>}
          <button type="button" className="eos-thing__remove" aria-label={`Remove ${t.label}`} onClick={() => onRemove(t.id)}>×</button>
        </li>
      ))}
    </ul>
  );
}
