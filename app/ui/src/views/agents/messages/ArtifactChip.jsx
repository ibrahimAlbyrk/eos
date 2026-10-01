import { useMemo } from "react";
import { artifactChipHtml } from "../../../lib/artifactLink.js";
import { useArtifactPeek } from "./ArtifactPeek.jsx";

// The Artifact tool row's chip — the same markup prose chips get, so both look
// and hover alike.
export function ArtifactChip({ url, title }) {
  const peek = useArtifactPeek();
  const html = useMemo(() => artifactChipHtml({ url, title }), [url, title]);
  return (
    <>
      <span className="art-chip-host" {...peek.handlers} dangerouslySetInnerHTML={{ __html: html }} />
      {peek.layer}
    </>
  );
}
