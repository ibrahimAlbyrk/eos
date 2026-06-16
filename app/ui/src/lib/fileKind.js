// Pure path→viewer-kind classifier for the file panel. "text" is the default;
// extension-less binaries are caught server-side (fs/read null-byte sniff).

const KIND_BY_EXT = new Map();
function add(kind, exts) {
  for (const e of exts) KIND_BY_EXT.set(e, kind);
}
add("image", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
add("pdf", ["pdf"]);
add("html", ["html", "htm"]);
add("video", ["mp4", "m4v", "webm", "mov"]);
add("audio", ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);

export function fileKind(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return KIND_BY_EXT.get(ext) ?? "text";
}
