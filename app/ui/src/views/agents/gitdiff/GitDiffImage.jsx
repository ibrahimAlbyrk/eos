import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";

// Extension match decides image rendering — git's binary flag misses SVGs
// (text) and the flag isn't even loaded for embedded-patch-less files.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

export function isImagePath(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

// Before/after card for an image file. Sides follow the status: added shows
// only the new image, deleted only the old, modified/renamed both. Old sides
// always come from a git blob (base or commit parent); the new side is the
// working tree for the "all" scope and the commit's blob for a commit scope.
export function GitDiffImage({ file, cwd, baseSha, headSha, scope }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.path, scope.kind, scope.sha]);
  if (failed) return <div className="dv-patch-note">Binary file</div>;

  const isCommit = scope.kind === "commit";
  // baseSha null = root commit — there is no old side to show.
  const oldUrl = baseSha ? api.gitBlobUrl(cwd, baseSha, file.oldPath ?? file.path) : null;
  const newUrl = isCommit ? api.gitBlobUrl(cwd, headSha, file.path) : api.imageUrl(cwd + "/" + file.path);

  const sides = [];
  const added = file.untracked || file.status === "A";
  if (!added && file.status !== "D" && oldUrl) sides.push({ key: "old", label: "Before", url: oldUrl });
  if (file.status !== "D") sides.push({ key: "new", label: "After", url: newUrl });
  else if (oldUrl) sides.push({ key: "old", label: "Before", url: oldUrl });
  if (sides.length === 0) return <div className="dv-patch-note">Binary file</div>;

  const both = sides.length > 1;
  return (
    <div className="gd-img-wrap">
      {sides.map((s) => (
        <figure className={"gd-img-side gd-img-" + s.key} key={s.key}>
          {both && <figcaption>{s.label}</figcaption>}
          <img src={s.url} alt={`${file.path} (${s.label.toLowerCase()})`} onError={() => setFailed(true)} />
        </figure>
      ))}
    </div>
  );
}
