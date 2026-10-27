// File-type glyphs (house style: viewBox 0 0 16 16, currentColor stroke) as SVG
// markup, so a React icon (views/files/FileIcon.jsx) and an HTML-string chip in
// chat prose draw the same shapes. Files are bucketed by extension into a few
// visually-distinct categories.

const EXT = new Map();
const reg = (cat, exts) => exts.forEach((e) => EXT.set(e, cat));
reg("code", ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cc", "cs", "php", "swift", "kt", "sh", "bash", "zsh", "lua", "vue", "svelte", "json", "yaml", "yml", "toml"]);
reg("image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export function fileCategory(name) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT.get(ext) ?? "file";
}

const DOC = '<path d="M4 2h5l3 3v9a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0V2Z"/><path d="M9 2v3h3"/>';
const INNER = {
  folder: '<path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z"/>',
  folderOpen:
    '<path d="M2 4.4a1 1 0 0 1 1-1h2.5l1.2 1.4H13a1 1 0 0 1 1 1v.7H4.6a1 1 0 0 0-.95.68L2 12.5V4.4Z"/>'
    + '<path d="M2 12.5 3.65 7.18A1 1 0 0 1 4.6 6.5H15l-1.7 5.32a1 1 0 0 1-.95.68H3a1 1 0 0 1-1-1Z"/>',
  code: DOC + '<path d="M6.6 9 5.2 10.5l1.4 1.5M9.4 9l1.4 1.5-1.4 1.5" stroke-width="1.2"/>',
  image: DOC + '<circle cx="6.3" cy="8.6" r="0.9"/><path d="M5 12.5 7.2 10l1.3 1.2L10 9.6l1.5 2" stroke-width="1.2"/>',
  file: DOC + '<path d="M6 9h4M6 11h3" stroke-width="1.2"/>',
};

// The inner markup of a glyph: a folder (open or closed) or a file by its name.
export function glyphInner({ type, name = "", open = false }) {
  if (type === "directory") return open ? INNER.folderOpen : INNER.folder;
  return INNER[fileCategory(name)];
}

export const GLYPH_SVG_ATTRS = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

export function glyphSvg(entry, { size = 13, className = "" } = {}) {
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} width="${size}" height="${size}" ${GLYPH_SVG_ATTRS} aria-hidden="true">${glyphInner(entry)}</svg>`;
}
