import { useArtifactStill } from "../../state/artifactViewStore.js";

// Pieces the artifact card, peek, tab and list share.

// The artifact's look before it's live: main's still of this version, else a
// tile in the artifact's own tint with its emoji.
export function ArtifactThumb({ info, artRef, className = "" }) {
  const still = useArtifactStill(artRef);
  if (still) {
    return (
      <span className={"art-thumb " + className} aria-hidden="true">
        <img src={still} alt="" draggable={false} />
      </span>
    );
  }
  return <ArtifactTile info={info} className={className} />;
}

export function ArtifactTile({ info, className = "" }) {
  return (
    <span className={"art-tile " + className} data-tint={info.tint ?? undefined} aria-hidden="true">
      {info.favicon ? <span className="art-tile__emoji">{info.favicon}</span> : <WindowGlyph size={14} />}
    </span>
  );
}

// A sign-in's initial in its own tint (artifacts.css data-av).
export function AccountAvatar({ account, size = "md" }) {
  if (!account) return null;
  return (
    <span className={`art-av art-av--${size}`} data-av={account.tint ?? undefined} title={account.label} role="img" aria-label={account.label}>
      {account.initial}
    </span>
  );
}

export function WindowGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M2.5 6h11" />
    </svg>
  );
}

export function GridGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  );
}

export function ChevronRight({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function ChevronDown({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 6.5L8 10l3.5-3.5" />
    </svg>
  );
}

export function RefreshGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" />
    </svg>
  );
}

export function SearchGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L13.5 13.5" />
    </svg>
  );
}
