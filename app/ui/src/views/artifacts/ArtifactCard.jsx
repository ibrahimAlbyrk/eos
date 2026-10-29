import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useArtifactCatalog } from "../../state/artifactCatalogStore.js";
import { artifactBridge, warmArtifact } from "../../state/artifactViewStore.js";
import { artifactInfo, artifactMeta, artifactRef } from "../../lib/artifacts.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { AccountAvatar, ArtifactThumb, ChevronRight } from "./ArtifactParts.jsx";

// The slug of the chat's newest artifact (Messages): its card warms the live
// view as it scrolls into view, so the first hover or click is instant.
export const NewestArtifactContext = createContext(null);

// The Artifact tool row's card: thumb, title, "Page · v3 · just now", the
// account it lives in, "Open ›". A link like every artifact link
// (useArtifactLinks.jsx handles click and hover); `artifact` is
// lib/artifactLink.js artifactFromTool plus the call's ts.
export function ArtifactCard({ artifact }) {
  const catalog = useArtifactCatalog();
  const now = useClockTick(true, 30_000);
  const info = artifactInfo(artifact.slug, { url: artifact.url, title: artifact.title, ts: artifact.ts }, catalog);
  const refKey = `${info.slug}|${info.loginId}|${info.url}|${info.version}|${info.title}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const artRef = useMemo(() => artifactRef(info), [refKey]);
  const el = useRef(null);
  const newest = useContext(NewestArtifactContext);
  const warm = Boolean(info.slug) && newest === info.slug;

  useEffect(() => {
    const node = el.current;
    if (!warm || !node || !artifactBridge() || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      warmArtifact(artRef);
    });
    io.observe(node);
    return () => io.disconnect();
  }, [warm, artRef]);

  return (
    <a
      ref={el}
      className="art-card"
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      data-art-slug={info.slug ?? undefined}
      data-title={info.title}
      data-login-id={info.loginId ?? undefined}
    >
      <ArtifactThumb info={info} artRef={artRef} className="art-card__thumb" />
      <span className="art-card__text">
        <span className="art-card__title">{info.title}</span>
        <span className="art-card__meta">{artifactMeta(info, now)}</span>
      </span>
      <AccountAvatar account={info.account} />
      <span className="art-card__open">Open<ChevronRight /></span>
    </a>
  );
}
