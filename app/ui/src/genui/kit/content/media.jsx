// Images that never break: each tries its sources in order (proxy URLs from
// useView().media), shimmers while loading and ends on a monogram.

import { useState } from "react";
import { monogram } from "../monogram.js";
import { cls } from "./util.js";

// Initials on the name's hashed tone: a circle (avatar, place logo) or a
// rounded square (brand logo, source favicon).
export function Monogram({ name, size = 32, round = false, className, label }) {
  const m = monogram(name);
  return (
    <span
      className={cls("gv-mono", `gv-mono-${m.tone}`, round && "is-round", className)}
      style={{ "--gv-mono-size": `${size}px` }}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : "true"}
    >
      {m.initials}
    </span>
  );
}

// The photo fallback: a dark gradient on the name's tone, initials optional.
export function MonoTile({ name, initials = true, className, children }) {
  const m = monogram(name);
  return (
    <span className={cls("gv-monotile", `gv-mono-${m.tone}`, className)} aria-hidden="true">
      {initials ? <span className="gv-monotile-mark">{m.initials}</span> : null}
      {children}
    </span>
  );
}

// One <img> over a list of candidate URLs; on error it moves to the next, and
// with none left it renders `fallback`. The wrapper shimmers until a load.
export function MediaImg({ srcs, alt = "", fallback = null, className, imgClassName, fit = "cover" }) {
  const list = Array.isArray(srcs) ? srcs.filter(Boolean) : [];
  const key = list.join("\n");
  const [st, setSt] = useState({ key, i: 0, loaded: false });
  const cur = st.key === key ? st : { key, i: 0, loaded: false };
  if (cur.i >= list.length) return fallback;
  return (
    <span className={cls("gv-media", !cur.loaded && "gv-shimmer", className)}>
      <img
        key={list[cur.i]}
        className={cls("gv-media-img", fit === "contain" && "is-contain", cur.loaded && "is-loaded", imgClassName)}
        src={list[cur.i]}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
        onLoad={() => setSt({ key, i: cur.i, loaded: true })}
        onError={() => setSt({ key, i: cur.i + 1, loaded: false })}
      />
    </span>
  );
}
