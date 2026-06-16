// Inline-SVG file-type glyphs (no icon library — house style: viewBox 0 0 16 16,
// currentColor stroke). Folders get open/closed variants; files are bucketed by
// extension into a few visually-distinct categories. Color comes from the
// parent row's `color` so it follows the theme.

const EXT = new Map();
const reg = (cat, exts) => exts.forEach((e) => EXT.set(e, cat));
reg("code", ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cc", "cs", "php", "swift", "kt", "sh", "bash", "zsh", "lua", "vue", "svelte", "json", "yaml", "yml", "toml"]);
reg("image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function categoryFor(name) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT.get(ext) ?? "file";
}

function FolderGlyph({ open }) {
  return open ? (
    <svg className="fx-icon fx-icon--dir" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.4a1 1 0 0 1 1-1h2.5l1.2 1.4H13a1 1 0 0 1 1 1v.7H4.6a1 1 0 0 0-.95.68L2 12.5V4.4Z" />
      <path d="M2 12.5 3.65 7.18A1 1 0 0 1 4.6 6.5H15l-1.7 5.32a1 1 0 0 1-.95.68H3a1 1 0 0 1-1-1Z" />
    </svg>
  ) : (
    <svg className="fx-icon fx-icon--dir" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" />
    </svg>
  );
}

function DocGlyph({ category }) {
  return (
    <svg className="fx-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h5l3 3v9a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0V2Z" />
      <path d="M9 2v3h3" />
      {category === "code" && <path d="M6.6 9 5.2 10.5l1.4 1.5M9.4 9l1.4 1.5-1.4 1.5" strokeWidth="1.2" />}
      {category === "image" && <><circle cx="6.3" cy="8.6" r="0.9" /><path d="M5 12.5 7.2 10l1.3 1.2L10 9.6l1.5 2" strokeWidth="1.2" /></>}
      {category === "file" && <><path d="M6 9h4M6 11h3" strokeWidth="1.2" /></>}
    </svg>
  );
}

export function FileIcon({ type, name, expanded }) {
  if (type === "directory") return <FolderGlyph open={expanded} />;
  return <DocGlyph category={categoryFor(name)} />;
}
